const core = require("@actions/core");
const axios = require('axios');

async function run() {
  try {
    const path = '.build_number';
    const prefix = process.env.INPUT_PREFIX ? `${process.env.INPUT_PREFIX}-` : '';
    
    if (process.env.INPUT_PREFIX) {
      console.log(`Using Prefix ${prefix}...`)
    }

    //See if we've already generated the build number and are in later steps...
    if (fs.existsSync(path)) {
        let buildNumber = fs.readFileSync(path);
        console.log(`Build number already generated: ${buildNumber}`);
        console.log(`::set-env name=BUILD_NUMBER::${buildNumber}`);
        console.log(`::set-output name=build_number::${buildNumber}`);
        return;
    }

    for (let varName of ['INPUT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA']) {
      if (!process.env[varName]) {
          const error = new Error(`ERROR: Environment variable ${varName} is not defined.`)
          throw error
      }
    }
    
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run();