;(function() {
  'use strict';

  if (isFinite(process.env.TRAVIS_PULL_REQUEST)) {
    console.error('Testing skipped for pull requests');
    process.exit(0);
  }

  /** Load Node.js modules */
  var http = require('http'),
      path = require('path'),
      url = require('url');

  /** Load other modules */
  var _ = require('../lodash'),
      ecstatic = require('ecstatic'),
      request = require('request'),
      SauceTunnel = require('sauce-tunnel');

  /** Used by `logInline` */
  var attempts = -1,
      prevLine = '';

  /** Used as request `auth` and `options` values */
  var port = 8081,
      username = process.env.SAUCE_USERNAME,
      accessKey = process.env.SAUCE_ACCESS_KEY,
      tunnelId = 'lodash_' + process.env.TRAVIS_JOB_NUMBER;

  var compatMode = process.argv.reduce(function(result, value) {
    return optionToValue('compatMode', value) || result;
  }, null);

  var runner = process.argv.reduce(function(result, value) {
    value = optionToValue('runner', value);
    return value == null
      ? result
      : '/' + value.replace(/^\W+/, '');
  }, '/test/index.html');

  var sessionName = process.argv.reduce(function(result, value) {
    return optionToValue('name', value) || result;
  }, 'lodash tests');

  var tags = process.argv.reduce(function(result, value) {
    value = optionToArray('tags', value);
    return value.length
      ? _.union(result, value)
      : result;
  }, []);

  /** List of platforms to load the runner on */
  var platforms = [
    ['Windows 7', 'chrome', ''],
    ['Windows 7', 'firefox', '25'],
    ['Windows 7', 'firefox', '20'],
    ['Windows 7', 'firefox', '10'],
    ['Windows 7', 'firefox', '6'],
    ['Windows 7', 'firefox', '4'],
    ['Windows 7', 'firefox', '3'],
    ['WIN8.1', 'internet explorer', '11'],
    ['Windows 7', 'internet explorer', '10'],
    ['Windows 7', 'internet explorer', '9'],
    ['Windows 7', 'internet explorer', '8'],
    ['Windows XP', 'internet explorer', '7'],
    ['Windows XP', 'internet explorer', '6'],
    //['Windows 7', 'opera', '12'],
    //['Windows 7', 'opera', '11'],
    ['OS X 10.8', 'safari', '6'],
    ['Windows 7', 'safari', '5']
  ];

  /** Used to tailor the `platforms` array */
  var runnerQuery = url.parse(runner, true).query,
      isBackbone = /\bbackbone\b/i.test(runner),
      isMobile = /\bmobile\b/i.test(runnerQuery.build),
      isModern = /\bmodern\b/i.test(runnerQuery.build);

  // platforms to test IE compat mode
  if (compatMode) {
    platforms = [
      ['WIN8.1', 'internet explorer', '11'],
      ['Windows 7', 'internet explorer', '10'],
      ['Windows 7', 'internet explorer', '9'],
      ['Windows 7', 'internet explorer', '8']
    ];
  }
  // platforms for Backbone tests
  if (isBackbone) {
    platforms = platforms.filter(function(platform) {
      var browser = platform[1],
          version = +platform[2];

      switch (browser) {
        case 'firefox': return version >= 4;
        case 'opera': return version >= 12;
      }
      return true;
    });
  }
  // platforms for mobile and modern builds
  if (isMobile || isModern) {
    platforms = platforms.filter(function(platform) {
      var browser = platform[1],
          version = +platform[2];

      switch (browser) {
        case 'firefox': return version >= 10;
        case 'internet explorer': return version >= 9;
        case 'opera': return version >= 12;
        case 'safari': return version >= (isMobile ? 5 : 6);
      }
      return true;
    });
  }

  /*--------------------------------------------------------------------------*/

  /**
   * Logs an inline message to standard output.
   *
   * @private
   * @param {string} text The text to log.
   */
  function logInline(text) {
    var blankLine = repeat(' ', prevLine.length);
    if (text.length > 40) {
      text = text.slice(0, 37) + '...';
    }
    prevLine = text;
    process.stdout.write(text + blankLine.slice(text.length) + '\r');
  }

  /**
   * Converts a comma separated option value into an array.
   *
   * @private
   * @param {string} name The name of the option to inspect.
   * @param {string} string The options string.
   * @returns {Array} Returns the new converted array.
   */
  function optionToArray(name, string) {
    return _.compact(_.isArray(string)
      ? string
      : _.invoke((optionToValue(name, string) || '').split(/, */), 'trim')
    );
  }

  /**
   * Extracts the option value from an option string.
   *
   * @private
   * @param {string} name The name of the option to inspect.
   * @param {string} string The options string.
   * @returns {string|undefined} Returns the option value, else `undefined`.
   */
  function optionToValue(name, string) {
    var result = (result = string.match(RegExp('^' + name + '=([\\s\\S]+)$'))) && result[1].trim();
    return result || undefined;
  }

  /**
   * Creates a string with `text` repeated `n` number of times.
   *
   * @private
   * @param {string} text The text to repeat.
   * @param {number} n The number of times to repeat `text`.
   * @returns {string} The created string.
   */
  function repeat(text, n) {
    return Array(n + 1).join(text);
  }

  /*--------------------------------------------------------------------------*/

  /**
   * Processes the result object of the test session.
   *
   * @private
   * @param {Object} results The result object to process.
   */
  function handleTestResults(results) {
    var failingTests = results.filter(function(test) {
      var result = test.result;
      return !result || result.failed || /\berror\b/i.test(result.message);
    });

    var failingPlatforms = failingTests.map(function(test) {
      return test.platform;
    });

    if (!failingTests.length) {
      console.log('Tests passed');
    }
    else {
      console.error('Tests failed on platforms: ' + JSON.stringify(failingPlatforms));

      failingTests.forEach(function(test) {
        var details =  'See ' + test.url + ' for details.',
            platform = JSON.stringify(test.platform),
            result = test.result;

        if (result && result.failed) {
          console.error(result.failed + ' failures on ' + platform + '. ' + details);
        } else {
          console.error('Testing on ' + platform + ' failed; no results available. ' + details);
        }
      });
    }

    console.log('Shutting down Sauce Connect tunnel...');

    tunnel.stop(function() {
      process.exit(failingTests.length ? 1 : 0);
    });
  }

  /**
   * Makes a request for Sauce Labs to start the test session.
   *
   * @private
   */
  function runTests() {
    var options = {
      'framework': 'qunit',
      'name': sessionName,
      'public': 'public',
      'platforms': platforms,
      'record-screenshots': false,
      'tags': tags,
      'tunnel': 'tunnel-identifier:' + tunnelId,
      'url': 'http://localhost:' + port + runner,
      'video-upload-on-pass': false
    };

    console.log('Starting saucelabs tests: ' + JSON.stringify(options));

    request.post('https://saucelabs.com/rest/v1/' + username + '/js-tests', {
      'auth': { 'user': username, 'pass': accessKey },
      'json': options
    }, function(error, response, body) {
      var statusCode = response && response.statusCode;
      if (statusCode == 200) {
        waitForTestCompletion(body);
      } else {
        console.error('Failed to submit test to Sauce Labs; status: ' +  statusCode + ', body:\n' + JSON.stringify(body));
        if (error) {
          console.error(error);
        }
        process.exit(3);
      }
    });
  }

  /**
   * Checks the status of the test session. If the session has completed it
   * passes the result object to `handleTestResults`, else it checks the status
   * again in five seconds.
   *
   * @private
   * @param {Object} testIdentifier The object used to identify the session.
   */
  function waitForTestCompletion(testIdentifier) {
    request.post('https://saucelabs.com/rest/v1/' + username + '/js-tests/status', {
      'auth': { 'user': username, 'pass': accessKey },
      'json': testIdentifier
    }, function(error, response, body) {
        var statusCode = response && response.statusCode;
        if (statusCode == 200) {
          if (body.completed) {
            logInline('');
            handleTestResults(body['js tests']);
          }
          else {
            logInline('Please wait' + repeat('.', (++attempts % 3) + 1));
            setTimeout(function() {
              waitForTestCompletion(testIdentifier);
            }, 5000);
          }
        } else {
          logInline('');
          console.error('Failed to check test status on Sauce Labs; status: ' + statusCode + ', body:\n' + JSON.stringify(body));
          if (error) {
            console.error(error);
          }
          process.exit(4);
        }
    });
  }

  /*--------------------------------------------------------------------------*/

  // create a web server for the local dir
  var mount = ecstatic({
    'root': process.cwd(),
    'cache': false
  });

  http.createServer(function(req, res) {
    // see http://msdn.microsoft.com/en-us/library/ff955275(v=vs.85).aspx
    if (compatMode && path.extname(url.parse(req.url).pathname) == '.html') {
      res.setHeader('X-UA-Compatible', 'IE=' + compatMode);
    }
    mount(req, res);
  }).listen(port);

  // set up Sauce Connect so we can use this server from Sauce Labs
  var tunnelTimeout = 10000,
      tunnel = new SauceTunnel(username, accessKey, tunnelId, true, tunnelTimeout);

  console.log('Opening Sauce Connect tunnel...');

  tunnel.start(function(success) {
    if (success) {
      console.log('Sauce Connect tunnel opened');
      runTests();
    } else {
      console.error('Failed to open Sauce Connect tunnel');
      process.exit(2);
    }
  });
}());
