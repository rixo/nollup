if (!process.env.ROLLUP_WATCH) {
    process.env.ROLLUP_WATCH = 'true';
}

if (!process.env.NOLLUP) {
    process.env.NOLLUP = 'true';
}

const fs = require('fs');
const path = require('path');
const express = require('express');
const fallback = require('express-history-api-fallback');
const proxy = require('express-http-proxy');
const nollupDevMiddleware = require('./dev-middleware');
const ConfigLoader = require('./impl/ConfigLoader');

const watch = config => {
  const options = fs.existsSync('.nolluprc')
    ? Object.assign({}, JSON.parse(fs.readFileSync('.nolluprc')))
    : fs.existsSync('.nolluprc.js')
    ? Object.assign({}, require(path.resolve(process.cwd(), './.nolluprc.js')))
    : {
      hot: true,
      port: 3333,
    }

  const changeListeners = []
  const bundleListeners = []

  const on = (event, fn) => {
    if (event === 'change') changeListeners.push(fn)
    else if (event === 'event') bundleListeners.push(fn)
    else throw new Error('Unsupported event: ' + event)
  }

  const notify = listeners => (...args) => listeners.forEach(fn => fn(...args))

  const notifyChange = notify(changeListeners)
  const notifyBundle = notify(bundleListeners)

  const app = express()

  app.use(
    nollupDevMiddleware(app, {
      ...config,
      output: {
        ...config.output,
        // dir: path.relative(process.cwd(), config.output.dir)
        dir: 'client'
      }
    }, {
      hot: options.hot,
      verbose: options.verbose,
      hmrHost: options.hmrHost,
      contentBase: options.contentBase,
      publicPath: 'client',
      watch: 'src',

      onChange: notifyChange,
      onBundle: notifyBundle,
    })
  )

  app.use(express.static(options.contentBase || 'static'));

  app.use(proxy(`localhost:${process.env.PORT || '3000'}`))

  app.listen(options.port)

  console.log(
    `[Nollup] Listening on http://${options.hmrHost || 'localhost'}:${options.port}`
  )

  return { on }
}

module.exports = { watch }
