let AcornParser = require('./AcornParser');
let PluginContext = require('./PluginContext');
let path = require('path');
let { resolvePath, getNameFromFileName } = require('./utils');

function getInputEntries (input) {
    let getFile = file => path.resolve(process.cwd(), file);

    if (!input) {
        throw new Error('Input option not defined');
    }

    if (typeof input === 'string') {
        return [{ 
            name: getNameFromFileName(input),
            file: getFile(input)
        }];
    }

    if (Array.isArray(input)) {
        return input.map(file => {
            return {
                name: getNameFromFileName(file),
                file: getFile(file)
            };
        });
    }

    if (typeof input === 'object') {
        return Object.keys(input).map(key => {
            return {
                name: key,
                file: getFile(input[key])
            };
        });
    }
}

function applyDefaultOptions (opts) {
    return {
        input: opts.input,
        output: {
            assetFileNames: 'assets/[name]-[hash][extname]',
            chunkFileNames: '[name]-[hash].js',
            entryFileNames: '[name].js',
            format: 'esm',
            globals: {},
            ...opts.output,
        },
        plugins: (opts.plugins || []).filter(p => Boolean(p)),
        external: opts.external || []
    };
}

function callOptionsHook (options) {
    options.plugins.forEach(plugin => {
        if (plugin.options) {
            options = plugin.options.call({
                meta: PluginContext.meta
            }, options) || options;
        }
    });

    return options;
}

function callOutputOptionsHook (context, outputOptions) {
    context.plugins.forEach(plugin => {
        if (plugin.outputOptions) {
            outputOptions = plugin.outputOptions.call({
                meta: PluginContext.meta
            }, outputOptions) || outputOptions;
        }
    });

    return outputOptions;
}

module.exports = {
    create (options) {
        if (options.acornInjectPlugins) {
            AcornParser.inject(options.acornInjectPlugins);
        }

        options = applyDefaultOptions(options);
        options = callOptionsHook(options);
        
        let context = {
            options: options,
            input: getInputEntries(options.input),
            output: options.output,
            plugins: options.plugins,
            external: options.external,
            files: {}, // directory of all files parsed and cached
            dynamicChunks: {},
            emittedChunks: {},
            emittedAssets: {},
            watchFiles: {}, // additional files to watch
            externalFiles: {}, //directory of external files to load
            pluginsContext: [], // plugin context instances for plugins
            moduleIdGenerator: 0, // incremented as each file is parsed
            syntheticNamedExports: {}, // module ids with synthetic exports
            previousBundleModuleIds: new Set(), // used for hmr comparison
        };

        context.pluginsContext = options.plugins.map(p => {
            return PluginContext.create(context, p);
        });

        return context;
    },

    invalidate (context, filePath) {
        filePath = resolvePath(filePath, process.cwd() + '/__entry__');
        if (context.files[filePath]) {
            context.files[filePath].invalidate = true;
        }

         if (context.watchFiles[filePath]) {
            context.files[context.watchFiles[filePath]].invalidate = true;
        }
    },

    setOutputOptions (context, outputOptions) {
        callOutputOptionsHook(context, outputOptions);

        context.output = {
            ...context.output,
            ...outputOptions
        };
    }
}