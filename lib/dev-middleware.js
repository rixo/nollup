let nollup = require('./index');
let chokidar = require('chokidar');
let expressws = require('express-ws');
let fs = require('fs');
let url = require('url');
let hmr = require('./plugin-hmr');

const MIME_TYPES = {
    'mjs': 'application/javascript',
    'js': 'application/javascript',
    'css': 'text/css',
    'json': 'application/json',
    'svg': 'image/svg+xml'
};

module.exports = function (app, config, options) {
    expressws(app);
    let isBundling = true;
    let files = {};
    let sockets = {};
    let file_listeners = [];

    let configs = Array.isArray(config)? config : [config];

    if (options.hot) {
        configs.forEach((c, i) => {
            c.plugins = c.plugins || [];
            c.plugins.push(hmr({
                verbose: options.verbose,
                hmrHost: options.hmrHost,
                bundleId: i
            }));

            sockets[i] = [];

            app.ws('/__hmr_' + i, (ws, req) => {
                sockets[i].push(ws);

                ws.on('close', () => {
                    sockets[i].splice(sockets[i].indexOf(ws), 1);
                });
            });
        });
    }

    function messageAllSocketsInHotMode (message, bundleId) {
        if (!options.hot) {
            return;
        }

        if (bundleId !== undefined) {
            sockets[bundleId].forEach(socket => {
                socket.send(JSON.stringify(message));
            });
        } else {
            Object.keys(sockets).forEach(bundleId => {
                sockets[bundleId].forEach(socket => {
                    socket.send(JSON.stringify(message));
                });
            });
        }
    }

    function handleGeneratedBundle (response, bundleId) {
        let output = response.output;
        output.forEach(obj => {
            files[obj.fileName] = obj.isAsset? obj.source : obj.code;
        });

        messageAllSocketsInHotMode({ changes: response.changes }, bundleId);

        console.log('\x1b[32m%s\x1b[0m', `Compiled in ${response.stats.time}ms.`);
    }

    async function compiler () {
        let bundles = [];

        for (let i = 0; i < configs.length; i++) {
             bundles.push(await nollup(configs[i]));
        }
       
        let watcher = chokidar.watch(options.watch || process.cwd(), {
            ignored:  ['**/node_modules/**/*', '**/.git/**/*'],
        });       

        let watcherTimeout;

        const onChange = async (path) => {
            messageAllSocketsInHotMode({ status: 'check' });

            if (fs.lstatSync(path).isFile()) {
                isBundling = true;
                files = {};
                bundles.forEach(b => b.invalidate(path));

                if (watcherTimeout) {
                    clearTimeout(watcherTimeout);
                }

                watcherTimeout = setTimeout(async () => {
                    messageAllSocketsInHotMode({ status: 'prepare' });
                    try {
                        for (let i = 0; i < bundles.length; i++) {
                            let update = await bundles[i].generate();
                            messageAllSocketsInHotMode({ status: 'ready' });
                            handleGeneratedBundle(update, i); 
                        }

                        isBundling = false;
                        file_listeners.forEach(fn => fn());
                    } catch (e) {
                        console.log('\x1b[91m%s\x1b[0m', e.stack);
                    }
                }, 100);
            }
        };

        watcher.on('add', onChange);
        watcher.on('change', onChange);

        try {
            for (let i = 0; i < bundles.length; i++) {
                handleGeneratedBundle(await bundles[i].generate(), i);
            }
            isBundling = false;
            file_listeners.forEach(fn => fn());
        } catch (e) {
            console.log('\x1b[91m%s\x1b[0m', e);
        }
        
    };

    compiler();

    return function (req, res, next) {
        let impl = () => {
            let filename = url.parse(req.url).pathname.replace('/', '');

            if (isBundling) {
                file_listeners.push(impl);
                return;
            }

            if (files[filename]) {
                res.writeHead(200, {
                    'Content-Type': MIME_TYPES[filename.substring(filename.lastIndexOf('.') + 1)]
                });

                res.write(files[filename]);
                res.end();
            } else {
                next();
            }
        }

        impl();
    }
};
