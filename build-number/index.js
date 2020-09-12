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
    const tagRefs = response.data
    console.log(response.data)

    const regex = new RegExp(`/${prefix}build-number-(\\d+)$)`)
    const tags = tagRefs.filter(t => t.ref.match(regex))
    console.log(tags)

    return 1
  } catch (error) {
    // If non found, start with build 0
    console.log(error.response.status)
    if (error.response.status == 404) {
      console.log('Previous build not found...')
      return 0
    } else {
      throw error
    }
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