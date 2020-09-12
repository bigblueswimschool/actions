const fs = require('fs');
const core = require("@actions/core");
const axios = require('axios');

const tagPrefix = 'build-'
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || null

const github = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    'Authorization' : `token ${process.env.INPUT_TOKEN}`
  }
});

const getLastBuildNumber = async (prefix) => {
  try {
    const response = await github.get(`/repos/${GITHUB_REPOSITORY}/git/refs/tags/${prefix}${tagPrefix}`);
    const tags = response.data
    
    console.log(response.data)
    return 1
  } catch (error) {
    console.log(error)
    throw error
  }
}

async function run() {
  try {
    const path = '.build_number';
    const prefix = process.env.INPUT_PREFIX ? `${process.env.INPUT_PREFIX}-` : '';
    
    if (prefix.length > 0) {
      console.log(`Using Prefix ${prefix}...`)
    }

    // See if we've already generated a build number
    if (fs.existsSync(path)) {
        const buildNumber = fs.readFileSync(path);
        console.log(`Build number already generated: ${buildNumber}`);
        console.log(`::set-env name=BUILD_NUMBER::${buildNumber}`);
        console.log(`::set-output name=build_number::${buildNumber}`);
        return;
    }

    // Check environment vars
    for (let varName of ['INPUT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA']) {
      if (!process.env[varName]) {
          const error = new Error(`ERROR: Environment variable ${varName} is not defined.`)
          throw error
      }
    }

    const lastBuildNumber = await getLastBuildNumber(prefix);
    console.log(`Previous Build Number: ${lastBuildNumber}`);
    
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run();