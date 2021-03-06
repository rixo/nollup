let path = require('path');
let ConvertSourceMap = require('convert-source-map');
let ImportExportResolver = require('./impl/ImportExportResolver');
let NollupContext = require('./impl/NollupContext');
let PluginContext = require('./impl/PluginContext');
let PluginLifecycle = require('./impl/PluginLifecycle');
let AcornParser = require('./impl/AcornParser');
let ParseError = require('./impl/ParseError');
let { formatFileName, resolvePath } = require('./impl/utils');

/**
 * Loads target module.
 *
 * @method parse
 * @param {Context} context
 * @param {String} target
 * @param {String} current
 * @return {Promise}
 */
async function parse (context, filepath, current, level, isEntry, input_modules) { 
    if (level >= 255) {
        throw new Error('Maximum parse call stack exceeded.');
    }

    // If false, module is not included.
    if (filepath) {
        let file = context.files[filepath];

        if (!file) {
            file = {
                module_id: context.module_id_generator++,
                code: '',
                map: null,
                dependencies: [],
                dynamicDependencies: [],
                externalDependencies: {},
                exports: [],
                imports: [],
                invalidate: true,
                isEntry,
                checked: false
            };

            context.files[filepath] = file;
        }

        if (file.invalidate) {
            let oldDependencies = file.dependencies;
            PluginLifecycle.setCurrentFile(context, filepath);
            let loaded = await PluginLifecycle.load(context, filepath, current);
            let transformed = await PluginLifecycle.transform(context, loaded.code, filepath);
            let { 
                dependencies, 
                transpiled, 
                dynamicDependencies, 
                externalDependencies, 
                dynamicExternalDependencies,
                exports, 
                imports 
            } = await ImportExportResolver(transformed.code, context, filepath);

            file.code = transpiled;
            file.dependencies = dependencies;
            file.dynamicDependencies = dynamicDependencies;
            file.externalDependencies = externalDependencies;
            file.dynamicExternalDependencies = dynamicExternalDependencies;
            file.exports = exports;
            file.imports = imports;
            file.map = transformed.map;
            file.invalidate = false;

            Object.keys(file.externalDependencies).forEach(exDep => {
                if (!context.externalFiles[exDep]) {
                    context.externalFiles[exDep] = [];
                }
                
                context.externalFiles[exDep] = context.externalFiles[exDep].concat(file.externalDependencies[exDep]);
            });

            file.dynamicExternalDependencies.forEach(exDep => {
                context.dynamicExternalFiles[exDep] = {};
            });


            // Keeping references in a separate object so it's
            // not tied to whether or not a module successfully loads.
            // Unsuccessful loads can make it difficult to track references.
            oldDependencies.forEach(dep => {
                if (context.references[dep]) {
                    context.references[dep]--;
                }
            });

            file.dependencies.forEach(dep => {
                if (context.references[dep] === undefined) {
                    context.references[dep] = 0;
                }

                context.references[dep]++;
            });
        }    
        
        input_modules[filepath] = true;

        // Circular Dependency Check
        if (file.checked) {
            return;
        } else {
            file.checked = true;
        }

        let dependencies = file.dependencies;

        for (let i = 0; i < dependencies.length; i++) {
            try {
                await parse(context, dependencies[i], filepath, level + 1, false, input_modules);
            } catch (e) {
                throw new ParseError(dependencies[i], e);
            } 
        }

        let dynamicDependencies = file.dynamicDependencies;

        for (let i = 0; i < dynamicDependencies.length; i++) {
            let current_chunk = PluginLifecycle.getCurrentChunk(context);
            try {
                // TODO: How to detect if dynamic dependency is removed.
                if (!context.dynamicDependencies[dynamicDependencies[i]]) {
                    context.dynamicDependencies[dynamicDependencies[i]] = {};
                }

                PluginLifecycle.setCurrentChunk(context, formatFileName(context, dynamicDependencies[i], context.output.chunkFileNames));
                await parse(context, dynamicDependencies[i], filepath, 0, false, context.dynamicDependencies[dynamicDependencies[i]]);
            } catch (e) {
                throw new ParseError(dynamicDependencies[i], e);
            } finally {
                PluginLifecycle.setCurrentChunk(context, current_chunk);
            }
        }


    }
}

function createFileFunctionWrapper (context, filepath) {
    let { code, map, dependencies, dynamicDependencies, imports, syntheticNamedExports } = context.files[filepath];

    // Validate dependencies exist.
    dependencies.forEach(dep => {
        if (!context.files[dep]) {
            throw new Error('File not found: ' + dep);
        }
    });

    // Inject require numbers into module code.
    code = code.replace(/__nollup__dynamic__(\d+)/g, (match, index) => {
        let dependency = dynamicDependencies[index];

        if (!context.files[dependency]) {
            throw new Error('File not found: ' + dependency);
        }

        return `'./${formatFileName(context, dependency, context.output.chunkFileNames)}'`;
    });
    
    // Turning the code into eval statements, so we need
    // to escape line breaks and quotes. Using a multiline
    // approach here so that the compiled code is still
    // readable for advanced debugging situations.
    code = code
               .replace(/\\/g, '\\\\')
               .replace(/'/g, '\\\'')
               .replace(/(\r)?\n/g, '\\n\\\n')
               .replace(/\/\/# sourceMappingURL=(.*?)($|\n)/g, '') // remove existing sourcemapurls


    // Transform the source path so that they display well in the browser debugger.
    let sourcePath = path.relative(process.cwd(), filepath).replace(/\\/g, '/');

    // Append source mapping information
    if (map) {
        map.sourceRoot = 'nollup:///';
        map.sources[map.sources.length - 1] = sourcePath;
        code += `\\\n${ConvertSourceMap.fromObject(map).toComment()}`;
    } else {
        code += `\\\n//# sourceURL=${sourcePath}`;
    }

    return `
        function (__c__, __r__, __d__, __e__) {
            ${dependencies.map((d, i) => {
                return `var _i${i}`;
            }).join('; ')}

            ${imports.filter(i => i.local).map(node => {
                return `var ${node.local}`;
            }).join('; ')}

            ${imports.filter(i => !i.local).map(node => {
                return `var ex${node.importee}`;
            }).join('; ')}

            __d__(function () {
                ${imports.filter(i => i.local).map(node => {
                    return `${node.local} = ${node.importee}()${node.imported === '*'? '' : `.${node.imported}`}`;
                }).join('; ')}
                ${imports.filter(i => !i.local).map(node => {
                    return `ex${node.importee} = ${node.importee}()`;
                }).join('; ')}
            }, function (require, module, __nollup__global__) {
                "use strict";
                eval('${code}');
                ${syntheticNamedExports? 
                    `if (module.exports.default) {
                        for (var prop in module.exports.default) {
                            prop !== 'default' && __e__(prop, module.exports.default[prop]);
                        }
                    }`
                : ''}
            });

            ${dependencies.map((d, i) => {
                return `_i${i} = __c__(${context.files[d].module_id}) && function () { return __r__(${context.files[d].module_id}) }`;
            }).join('; ')}
        }   
    `.trim();
}

/**
 * Generates code. 
 *
 * @method generate
 * @param {Context}
 * @return {Promise}
 */
async function generate (context, input, dynamicFileName) {
    let intro = await PluginLifecycle.callPluginTextMethod(context, 'intro');
    let outro = await PluginLifecycle.callPluginTextMethod(context, 'outro');
    let banner = await PluginLifecycle.callPluginTextMethod(context, 'banner');
    let footer = await PluginLifecycle.callPluginTextMethod(context, 'footer');

    let files = Object.keys(input.modules).map(filepath => {
        return context.files[filepath].module_id + ':' + createFileFunctionWrapper(context, filepath);
    });  

    if (dynamicFileName) {
        return `
            (typeof self !== 'undefined' ? self : this).__nollup_dynamic_require_callback("./${dynamicFileName}", ${context.files[input.file].module_id}, {${files}});
        `;
    } else {
        return [
                banner,
                intro,
                context.output && context.output.format === 'esm'? Object.keys(context.externalFiles).map(dep => {
                    let output = '';
                    let depName = dep.replace(/[\W]/g, '_');
                    let specs = context.externalFiles[dep];
                    if (specs.indexOf('*') > -1) {
                        output += `import * as __nollup__external__${depName}__ from '${dep}';\n`;
                    }

                    if (specs.indexOf('default') > -1) {
                        output += `import __nollup__external__${depName}__default__ from '${dep}';\n`;
                    }

                    let named = specs.filter((v, i, t) => t.indexOf(v) === i && v !== '*' && v !== 'default');
                    if (named.length > 0) {
                        output += 'import { ' + named.map(i => {
                            return `${i} as __nollup__external__${depName}__${i}__`
                        }).join(', ') + ' } from \'' + dep + '\';\n';
                    }

                    return output;
                }).join('\n') : '',
                `
        ${(context.files[input.file].exports.length > 0 && context.output.format === 'esm')? 'var __nollup_entry_exports = ' : ''}(function (modules, __nollup__global__) {
            let instances = {};
            let chunks = {};

            let create_module = function (number) {

                let module = {
                    id: number,
                    dependencies: [],
                    exports: {},
                    invalidate: false,
                    __resolved: false,
                    __resolving: false
                };

                instances[number] = module;

                ${context.plugins.filter(p => p.nollupModuleInit).map(p => {
                    return `
                        (function () {
                            ${p.nollupModuleInit()}
                        })();
                    `;
                }).join('\n')}

                modules[number](function (dep) {
                    if (!instances[dep] || instances[dep].invalidate) {
                        create_module(dep);
                    }

                    if (instances[number].dependencies.indexOf(dep) === -1) {
                        instances[number].dependencies.push(dep);
                    }

                    return true;
                }, function (dep) {
                    return get_exports(module, dep);
                }, function(binder, impl) {
                    module.__binder = binder;
                    module.__impl = impl;
                }, function (bindingName, bindingValue) {
                    module.exports[bindingName] = bindingValue;
                
                    Object.keys(instances).forEach(key => {
                        if (instances[key].dependencies.indexOf(number) > -1) {
                            instances[key].__binder();
                        }
                    })
                });

                // Initially this will bind nothing, unless
                // the module has been replaced by HMR
                module.__binder();
            };

            let get_exports = function (parent, number) {
                return instances[number].exports;
            };

            let resolve_module = function (parent, number) {
                let module = instances[number];

                if (module.__resolved) {
                    return;
                }

                module.__resolving = true;

                let localRequire = function (dep) {
                    ${context.output.format === 'cjs'? `
                        if (typeof dep === 'string') {
                            return require(dep);
                        }

                        if (!modules[dep]) {
                            throw new Error([
                                'Module not found: ' + dep,
                                '- Module doesn\\'t exist in bundle.'
                            ].join('\\n'));
                        }
                    `: `
                        if (typeof dep === 'string' || !modules[dep]) {
                            throw new Error([
                                'Module not found: ' + dep,
                                '- Did you call "require" using a string?',
                                '- Check if you\\'re using untransformed CommonJS.',
                                '- If called with an id, module doesn\\'t exist in bundle.'
                            ].join('\\n'));
                        }
                    `}
                    return _require(module, dep);
                };

                ${context.output.format === 'cjs'? `
                    for (var prop in require) {
                        localRequire[prop] = require[prop];
                    }
                ` : ''}

                let executeModuleImpl = function (module) {
                    ${context.plugins.filter(p => p.nollupModuleWrap).reduce(
                        (code, p) => p.nollupModuleWrap(code),
                        `
                        module.__impl(localRequire, module, __nollup__global__);
                        module.__resolved = true;
                        `
                    )}
                };

                ${Object.keys(context.dynamicDependencies).length > 0 && `
                    localRequire.dynamic = function (file) {
                        return new Promise(function (resolve) {
                            if (chunks[file]) {
                                let mod = _require(module, chunks[file]);
                                resolve(mod);
                            } else {
                                let cb = () => resolve(_require(module, chunks[file]));
                                ${context.output.format === 'esm'? (`
                                    return import(file).then(cb);
                                `) : ''}
                                ${context.output.format === 'cjs'? (`
                                    return Promise.resolve(require(file)).then(cb);
                                `) : ''}
                            }
                        });
                    };
                `}

                module.dependencies.forEach((dep) => {
                    if (!instances[dep].__resolved && instances[dep].__resolving) {
                        instances[dep].dependencies.forEach(dep => {
                            if (!instances[dep].__resolved && !instances[dep].__resolving) {
                                resolve_module(module, dep);
                            }
                        });
                        executeModuleImpl(instances[dep]);
                    }

                    if (!instances[dep].__resolved && !instances[dep].__resolving) {
                        resolve_module(module, dep);
                    }
                });

                // Make sure module wasn't resolved as a result of circular dep.
                if (!module.__resolved) {
                    executeModuleImpl(module);                  
                }
            };

            let _require = function (parent, number) {
                if (!instances[number] || instances[number].invalidate) {
                    create_module(number);
                }

                resolve_module(parent, number);
                return instances[number].exports;
            };

            __nollup__global__.__nollup_dynamic_require_callback = function (file, chunk_entry_module, chunk_modules) {
                chunks[file] = chunk_entry_module;
                for (var key in chunk_modules) {
                    if (!modules[key]) {
                        modules[key] = chunk_modules[key];
                    }
                }
            };

            ${context.plugins.filter(p => p.nollupBundleInit).map(p => {
                return `
                    (function () {
                        ${p.nollupBundleInit()}
                    })();
                `;
            }).join('\n')}

            ${context.output.format === 'cjs'? `
                let result = _require(null, ${context.files[input.file].module_id});
                let result_keys = Object.keys(result);
                if (result_keys.length === 1 && result_keys[0] === 'default') {
                    module.exports = result.default;
                } else {
                    module.exports = result;
                }
            `: `
                return _require(null, ${context.files[input.file].module_id});
            `}
        })({
                `,
                files.join(','),
                `
        }, typeof globalThis !== 'undefined'? globalThis : (
           typeof self !== 'undefined' ? self : this
        ));

        ${context.output.format === 'esm'? context.files[input.file].exports.map(declaration => {
            if (declaration === 'default') {
                return 'export default __nollup_entry_exports.default;' 
            } else {
                return `export var ${declaration} = __nollup_entry_exports.${declaration};`
            }
        }).join('\n') : ''}
                `,
                outro,
                footer
            ].join('\n');
    }
}

/**
 * Bundles the code starting with the input.
 * Calls callback with output, stats, and error.
 *
 * @method bundle
 * @param {Context} context
 * @param {String} input
 * @param {Function} callback
 */
async function bundle (context) {
    let start = Date.now();

    let old_file_count = Object.keys(context.files).length;
    let invalidated = Object.keys(context.files).filter(filepath => context.files[filepath].invalidate);

    context.dynamicDependencies = {};

    Object.keys(context.files).forEach(key => {
        context.files[key].checked = false;
    });

    let buildFinish = async (arg) => {
        for (let i = 0; i < context.plugins.length; i++) {
            await PluginLifecycle.callPluginMethod(
                context.pluginsContext[i], 
                context.plugins[i], 
                'buildEnd',
                arg
            );
        }
    };
    
    try {
        for (let i = 0; i < context.plugins.length; i++) {
            await PluginLifecycle.callPluginMethod(
                context.pluginsContext[i],
                context.plugins[i], 
                'buildStart', 
                context.options
            );
        }

        for (let i = 0; i < context.input.length; i++) {
            context.input[i].modules = {};
            PluginLifecycle.setCurrentChunk(context, context.input[i].name + '.js');
            await parse(context, context.input[i].file, process.cwd() + '/__entry__', 0, true, context.input[i].modules);
        }
    } catch (e) {
        await buildFinish(e);
        throw new ParseError(PluginLifecycle.getCurrentChunk(context) || '', e);
    }    

    await buildFinish();

    for (let id in context.emitted) {
        if (context.emitted[id].moduleId) {
            try {
                context.emitted[id].modules = {};
                PluginLifecycle.setCurrentChunk(context, context.emitted[id].name + '.js');
                await parse(context, context.emitted[id].moduleId, process.cwd() + '/__entry__', 0, true, context.emitted[id].modules);
            } catch (e) {
                throw new ParseError(context.emitted[id].moduleId, e);
            }
        }
    }

    let changed_modules = invalidated.map(f => ({
        id: context.files[f].module_id,
        code: createFileFunctionWrapper(context, f)
    }));

    let new_modules = Object.keys(context.files).slice(old_file_count).map(f => ({
        id: context.files[f].module_id,
        code: createFileFunctionWrapper(context, f)
    }));

    let removed_modules = Object.keys(context.files).filter(f => {
        return context.references[f] <= 0 && !context.files[f].isEntry;
    }).map(f => {
        let id = context.files[f].module_id;
        delete context.files[f];
        return { id, removed: true };
    });

    for (let i = 0; i < context.input.length; i++) {
        let input = context.input[i];
        let opts = context.output;
        let fileName = opts.file? path.basename(opts.file) : formatFileName(context, input.name, opts.entryFileNames);

        context.bundle[fileName] = {
            fileName,
            name: input.name,
            isEntry: true,
            isDynamicEntry: false,
            type: 'chunk',
            code: await generate(context, input),
            map: null,
            modules: Object.keys(input.modules).reduce((acc, val) => (acc[val] = true) && acc, {}),
            imports: [],
            exports: context.files[input.file].exports
        };
    }

    for (let key in context.emitted) {
        if (context.emitted[key].moduleId) {
            let input = { file: context.emitted[key].moduleId, modules: context.emitted[key].modules };
            let opts = context.output;
            let fileName = context.emitted[key].fileName;

            context.bundle[fileName] = {
                fileName,
                name: input.file,
                code: await generate(context, input),
                map: null,
                isDynamicEntry: false,
                isEntry: true,
                type: 'chunk',
                modules: Object.keys(input.modules).reduce((acc, val) => (acc[val] = true) && acc, {}),
                imports: [],
                exports: context.files[input.file].exports
            };
        } 
    }

    for (let key in context.dynamicDependencies) {
        let input = { file: key, modules: context.dynamicDependencies[key] };
        let opts = context.output;
        let fileName = formatFileName(context, key, opts.chunkFileNames);

        context.bundle[fileName] = {
            fileName,
            name: input.file,
            isDynamicEntry: true,
            code: await generate(context, input, fileName),
            map: null,
            modules: Object.keys(input.modules).reduce((acc, val) => (acc[val] = true) && acc, {}),
            imports: [],
            exports: context.files[input.file].exports
        };
    }

    try {
        for (let i = 0; i < context.plugins.length; i++) {
            await PluginLifecycle.callPluginMethod(
                context.pluginsContext[i],
                context.plugins[i], 
                'renderStart', 
                context.output,
                context.options
            );
        }

        for (let key in context.bundle) {
            let file = context.bundle[key];
            if (!file.isAsset) {
                for (let i = 0; i < context.plugins.length; i++) {
                    let result = await PluginLifecycle.callPluginMethod(
                        context.pluginsContext[i],
                        context.plugins[i], 
                        'renderChunk', 
                        file.code,
                        file,
                        context.output
                    );

                    if (typeof result === 'string') {
                        context.bundle[key].code = result;
                    }

                    if (typeof result === 'object' && result !== null) {
                        context.bundle[key].code = result.code;
                        if (result.map) {
                            context.bundle[key].map = result.map;
                        }
                    }
                }
            }
        }
    } catch (e) {
        for (let i = 0; i < context.plugins.length; i++) {
            await PluginLifecycle.callPluginMethod(
                context.pluginsContext[i], 
                context.plugins[i], 
                'renderError', 
                e
            );
        }
    }
    

    for (let i = 0; i < context.plugins.length; i++) {
        await PluginLifecycle.callPluginMethod(
            context.pluginsContext[i], 
            context.plugins[i], 
            'generateBundle', 
            context.output, 
            context.bundle
        );
    }

    let props = {
        stats: {
            time: Date.now() - start 
        },
        changes: new_modules.concat(changed_modules).concat(removed_modules),
        output: Object.keys(context.bundle).map(fileName => context.bundle[fileName])
    };

    return props;
}

/**
 * Creates an instance of nollup bundler.
 * Accepts 'input', 'plugins' for options.
 * Callback is triggered each time modules are compiled.
 * Starts a watcher and compiles on file change.
 *
 * @method nollup
 * @param {Object} options
 * @param {Function} callback
 */
async function nollup (options) {
    if (options.acornInjectPlugins) {
        AcornParser.inject(options.acornInjectPlugins);
    }

    let queue = [];
    let processing = false;
    let context = NollupContext.create(options);

    async function generateImpl (resolve, reject) {
        processing = true;

        try {
            resolve(await bundle(context));
        } catch (e) {
            processing = false;
            reject(e);
        }

        processing = false;

        if (queue.length > 0) {
            queue.shift()();
        }
    }

    return {
        invalidate: file => {
            file = resolvePath(file, process.cwd() + '/__entry__');
            if (context.files[file]) {
                context.files[file].invalidate = true;
            }

            if (context.watchFiles[file]) {
                context.files[context.watchFiles[file]].invalidate = true;
            }
        },

        generate: (outputOptions) => {
            context.plugins.forEach(plugin => {
                if (plugin.outputOptions) {
                    let result = plugin.outputOptions(outputOptions);
                    if (result) {
                        outputOptions = result;
                    }
                }
            })

            if (outputOptions) {
                NollupContext.setOutput(context, outputOptions);
            }

            return new Promise((resolve, reject) => {
                if (processing) {
                    queue.push(() => generateImpl(resolve, reject));
                } else {
                    generateImpl(resolve, reject);
                }
            });
        }
    }    
}

module.exports = nollup;