/**
 * @license
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

// See https://github.com/GoogleChromeLabs/preload-webpack-plugin/issues/45
require('object.values').shim();

const objectAssign = require('object-assign');
const fs = require('fs');

const flatten = arr => arr.reduce((prev, curr) => prev.concat(curr), []);

const doesChunkBelongToHTML = (chunk, roots, visitedChunks) => {
  // Prevent circular recursion.
  // See https://github.com/GoogleChromeLabs/preload-webpack-plugin/issues/49
  if (visitedChunks[chunk.renderedHash]) {
    return false;
  }
  visitedChunks[chunk.renderedHash] = true;

  for (const root of roots) {
    if (root.hash === chunk.renderedHash) {
      return true;
    }
  }

  for (const parent of chunk.parents) {
    if (doesChunkBelongToHTML(parent, roots, visitedChunks)) {
      return true;
    }
  }

  return false;
};

const defaultOptions = {
  rel: 'preload',
  include: 'asyncChunks',
  fileBlacklist: [/\.map/],
  excludeHtmlNames: [],
};

class PreloadPlugin {
  constructor(options) {
    this.options = objectAssign({}, defaultOptions, options);
  }

  apply(compiler) {
    const options = this.options;
    compiler.plugin('compilation', compilation => {
      compilation.plugin('html-webpack-plugin-before-html-processing', (htmlPluginData, cb) => {
        if (this.options.excludeHtmlNames.indexOf(htmlPluginData.plugin.options.filename) > -1) {
          cb(null, htmlPluginData);
          return;
        }
        let filesToInclude = [];
        let extractedChunks = [];
        // 'asyncChunks' are chunks intended for lazy/async loading usually generated as
        // part of code-splitting with import() or require.ensure(). By default, asyncChunks
        // get wired up using link rel=preload when using this plugin. This behaviour can be
        // configured to preload all types of chunks or just prefetch chunks as needed.
        if (options.include === undefined || options.include === 'asyncChunks') {
          try {
            extractedChunks = compilation.chunks.filter(chunk => !chunk.isInitial());
          } catch (e) {
            extractedChunks = compilation.chunks;
          }
        } else if (options.include === 'initial') {
          try {
            extractedChunks = compilation.chunks.filter(chunk => chunk.isInitial());
          } catch (e) {
            extractedChunks = compilation.chunks;
          }
        } else if (options.include === 'allChunks' || options.include === 'all') {
          if (options.include === 'all') {
            /* eslint-disable no-console */
            console.warn('[WARNING]: { include: "all" } is deprecated, please use "allChunks" instead.');
            /* eslint-enable no-console */
          }
          // Async chunks, vendor chunks, normal chunks.
          extractedChunks = compilation.chunks;
        } else if (options.include === 'allAssets') {
          extractedChunks = [{files: Object.keys(compilation.assets)}];
        } else if (Array.isArray(options.include)) {
          // Keep only user specified chunks
          extractedChunks = compilation
              .chunks
              .filter((chunk) => {
                const chunkName = chunk.name;
                // Works only for named chunks
                if (!chunkName) {
                  return false;
                }
                return options.include.indexOf(chunkName) > -1;
              });
        }

        const publicPath = compilation.outputOptions.publicPath || '';

        // only handle the chunks associated to this htmlWebpackPlugin instance, in case of multiple html plugin outputs
        // allow `allAssets` mode to skip, as assets are just files to be filtered by black/whitelist, not real chunks
        if (options.include !== 'allAssets') {
          extractedChunks = extractedChunks.filter(chunk => doesChunkBelongToHTML(
            chunk, Object.values(htmlPluginData.assets.chunks), {}));
        }

        flatten(extractedChunks.map(chunk => chunk.files))
        .filter(entry => {
          return (
            !this.options.fileWhitelist ||
            this.options.fileWhitelist.some(regex => regex.test(entry) === true)
          );
        })
        .filter(entry => {
          return this.options.fileBlacklist.every(regex => regex.test(entry) === false);
        }).forEach(entry => {
          entry = `${publicPath}${entry}`;
          if (options.rel === 'preload') {
            // If `as` value is not provided in option, dynamically determine the correct
            // value depends on suffix of filename. Otherwise use the given `as` value.
            let asValue;
            if (!options.as) {
              if (entry.match(/\.css$/)) asValue = 'style';
              else if (entry.match(/\.woff2$/)) asValue = 'font';
              else asValue = 'script';
            } else if (typeof options.as === 'function') {
              asValue = options.as(entry);
            } else {
              asValue = options.as;
            }
            const crossOrigin = asValue === 'font' ? '; crossorigin=crossorigin' : '';
            filesToInclude.push(`<${entry}>; as=${asValue}; rel=${options.rel}${crossOrigin}`);
          } else {
            // If preload isn't specified, the only other valid entry is prefetch here
            // You could specify preconnect but as we're dealing with direct paths to resources
            // instead of origins that would make less sense.
            filesToInclude.push(`"<${entry}>; rel=${options.rel}`);
          }
        });

        if (filesToInclude.length > 0) {
            let links = filesToInclude.reduce((a,b) => a + ', ' + b)
            let header = `add_header Link "${links}";`
            let nginxFilename = htmlPluginData.plugin.options.filename + '.header';
            fs.writeFileSync(nginxFilename, header);
        }

        cb(null, htmlPluginData);
      });
    });
  }
}

module.exports = PreloadPlugin;
