#!/usr/bin/env node

var fs = require('fs');
var path = require('path');

var cheerio = require('cheerio');
var clc = require('cli-color');
var Table = require('cli-table2');
var semver = require('semver');
var Promise = require('promise');
var npmViewPromise = Promise.denodeify(require('npmview'));

require('promise/lib/rejection-tracking').enable();

var ROOT = path.join(__dirname, '../');


////////////////////////////////////////////////////////////////////////////////////////////////////

// "cordova-plugin-calendar@4.5.1",

// {
//   "locator": "https://github.com/EddyVerbruggen/cordova-plugin-googleplus#ecdb5276374a6aeaa363d349e24d63d2e9942c97",
//   "id": "cordova-plugin-googleplus"
// },

// {
//   "locator": "cordova-plugin-facebook4@1.7.1",
//   "id": "cordova-plugin-facebook4"
// },

////////////////////////////////////////////////////////////////////////////////////////////////////

/*
 * @param {String} pluginPgkJsonFile
 * @return {String|null} version
 */
function getVersionFromJSON(pluginPgkJsonFile) {
  if (fs.existsSync(pluginPgkJsonFile)) {
    var pluginPkgJson = require(pluginPgkJsonFile);
    return pluginPkgJson.version;
  } else {
    return null;
  }
}

/*
 * @param {String} pluginXMLFile
 * @return {String|null} version
 */
function getVersionFromXML(pluginXMLFile) {
  if (fs.existsSync(pluginXMLFile)) {
    var pluginXmlFileContent = fs.readFileSync(pluginXMLFile);
    var $ = cheerio.load(pluginXmlFileContent, {
      xmlMode: true
    });
    return $('plugin').attr('version');
  } else {
    return null;
  }
}

/*
 * @return {Array} of objects {
 *    pluginName: String
 *    pluginFolder: String
 *    expectedVersion: String | null
 *    installedVersionJson: String | null
 *    installedVersionXml: String | null
 * }
 */
function readPluginInfoFromDisk() {
  var allPluginsInfo = [];

  var cordovaPlugins = require(path.join(ROOT, 'package.json')).cordovaPlugins;
  cordovaPlugins.forEach(function(pluginInfo) {

    var pluginName, pluginExpectedVersion, pluginNameAndVersion;
    if (typeof pluginInfo == "object") {
      if (pluginInfo.locator && pluginInfo.locator.indexOf('@') > -1) {
        // looks like: 'foo@1.2.3'
        pluginNameAndVersion = pluginInfo.locator;
      } else {
        pluginNameAndVersion = pluginInfo.id + "@" + (pluginInfo.version || '');
      }
      // When using git locator, even when we have a commit hash in pluginInfo.locator, we can not verify
      // that contents of the folder come from this particular commit
      // The only way to make sure you have good version would be to reinstall each time but that would be brutal
    } else {
      pluginNameAndVersion = pluginInfo;
    }

    pluginName = pluginNameAndVersion.split('@')[0];
    pluginExpectedVersion = pluginNameAndVersion.split('@')[1]; // might be null if not specified

    // some plugins have different npm package name vs. id in plugin.xml...
    // e.g. https://github.com/BranchMetrics/cordova-ionic-phonegap-branch-deep-linking
    var pluginFolder = pluginInfo.id ? pluginInfo.id : pluginName;

    var pluginXmlFile = path.join(ROOT, 'plugins', pluginFolder, '/plugin.xml');
    var pluginJSONFile = path.join(ROOT, 'plugins', pluginFolder, '/package.json');

    var currentPluginInfo = {
      pluginName: pluginName,
      pluginFolder: pluginFolder,
      expectedVersion: pluginExpectedVersion,
      installedVersionJson: null,
      installedVersionXml: null,
      newestVersion: null
    };

    if (fs.existsSync(pluginXmlFile)) {
      // jsonVersion is more trustworthy if available, since when published to npm, package.json
      // needs to be correct, while version in plugin.xml might be outdated
      currentPluginInfo.installedVersionJson = getVersionFromJSON(pluginJSONFile);
      currentPluginInfo.installedVersionXml = getVersionFromXML(pluginXmlFile);
    }

    allPluginsInfo.push(currentPluginInfo);
  });

  return allPluginsInfo;
}

/*
 * @param {Array} allPluginsInfo
 * @return {cli-table2.Table}
 */
function postProcessPluginsInfo(allPluginsInfo) {
  //console.dir(allPluginsInfo);
  console.log();
  var table = new Table({
    head: [
      'Plugin name',
      'Expected',
      'Installed',
      'Newest'
    ]
  });

  var warnings = [];
  allPluginsInfo.forEach(function(currPluginInfo) {
    var pluginName = currPluginInfo.pluginName;

    var jsonVersion = currPluginInfo.installedVersionJson;
    var xmlVersion = currPluginInfo.installedVersionXml;

    if (jsonVersion && xmlVersion && jsonVersion !== xmlVersion) {
      var warning1 = pluginName + ': version in package.json(' + jsonVersion +
        ') does not match plugin.xml(' + xmlVersion + '), assuming version in package.json.';

      warnings.push(warning1);
    }

    if (currPluginInfo.pluginName !== currPluginInfo.pluginFolder) {
      var warning2 = pluginName + ': plugin npm name does not match its id from plugin.xml (' +
        currPluginInfo
        .pluginFolder + ')!';

      warnings.push(warning2);

      pluginName = pluginName + ' (' + currPluginInfo.pluginFolder + ')';
    }

    var installed = currPluginInfo.installedVersionJson || currPluginInfo.installedVersionXml;
    var newest = currPluginInfo.newestVersion;
    var expected = currPluginInfo.expectedVersion;

    if (newest && installed) {
      if (semver.gt(newest, installed)) {
        newest = clc.green.bold(newest);
      } else if (semver.lt(newest, installed)) {
        // weird stuff!
        newest = clc.red.bold(newest);
      }
    }

    if (expected && installed) {
      if (semver.gtr(installed, expected)) {
        installed = clc.red.bold(installed);
      } else if (semver.ltr(installed, expected)) {
        expected = clc.red.bold(expected);
      }
    }

    table.push([
      pluginName,
      expected || '-',
      installed || '-',
      newest || '-'
    ]);
  });

  if (warnings) {
    warnings.forEach(function(msg) {
      console.log(clc.yellow.bold(msg));
    });
  }

  console.log(
    '\nNote: if a plugin installed version was not detected, its id might differ from npm package name.');
  console.log('In this case, you need to specify the plugin entry in package.json as\n');
  console.log('  {locator: "npmname@version", id: "plugin.id.from.configxml"}');
  console.log('\nfor the plugin to be properly detected.');

  console.log(clc.yellow("\nConsider sending a PR to the plugin's maintainer to fix any issues."));

  return table;
}

/*
 * @return {Promise<Array>}
 */
function getNewestVersionsInfoFromNpm(allPluginsInfo) {
  process.stderr.write('fetching info from npm');
  var allPromisesToNpm = allPluginsInfo.map(function(pluginEntry) {
    var pluginName = pluginEntry.pluginName;
    return npmViewPromise(pluginName).then(function(latestVersionValue) {
      process.stderr.write('.'); // progress indicator
      return latestVersionValue;
    });
  });

  // each promise returns a value, .all() returns an array of those values
  return Promise.all(allPromisesToNpm);
}

function main() {
  var allPluginsInfo = readPluginInfoFromDisk();

  getNewestVersionsInfoFromNpm(allPluginsInfo).then(function(newestVersionsArr) {
    // augment the `allPluginsInfo` entries with a new subkey
    newestVersionsArr.forEach(function(item, idx) {
      allPluginsInfo[idx].newestVersion = newestVersionsArr[idx];
    });
    return allPluginsInfo;
  }).then(function(allPluginsInfo) {
    return postProcessPluginsInfo(allPluginsInfo);
  }).then(function(table) {
    // we got all the info, print!
    console.log();
    console.log(table.toString());
  }).catch(function(err) {
    console.log();
    console.log(clc.red.bold(err));
    console.log(err.stack);
  });
}

main();