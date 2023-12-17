const fs = require('fs');
const async = require('async');
const core = require("@actions/core");
const exec = require("@actions/exec");
const axios = require('axios');

const tagPrefix = 'build-'
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || null
const GITHUB_SHA = process.env.GITHUB_SHA || null

let existingTags = []

const github = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    'Authorization' : `token ${process.env.INPUT_TOKEN}`
  }
});

const getLastBuildNumber = async (prefix) => {
  try {
    // Fetch tag refs from github
    const response = await github.get(`/repos/${GITHUB_REPOSITORY}/git/refs/tags/${prefix}${tagPrefix}`);
    const tagRefs = response.data

    // Filter refs
    const tagRegex = new RegExp(`/${prefix}${tagPrefix}(\\d+)$`)
    existingTags = tagRefs.filter(t => t.ref.match(tagRegex))

    // Extract versions
    const existingVersions = existingTags.map(t => parseInt(t.ref.match(/-(\d+)$/)[1]))

    // Return max version
    const maxVersion = Math.max(...existingVersions)

    if (maxVersion > 0) {
      return maxVersion
    } else {
      const error = new Error('Invalid Max Version')
      throw error
    }
  } catch (error) {
    // If non found, start with build 0
    if (error && error.response && error.response.status == 404) {
      return 0
    } else {
      throw error
    }
  }
}

const saveBuildNumber = async (prefix, buildNumber) => {
  let newRef = {
    ref:`refs/tags/${prefix}${tagPrefix}${buildNumber}`,
    sha: GITHUB_SHA
  }
  try {
    await github.post(`/repos/${GITHUB_REPOSITORY}/git/refs`, newRef)
  } catch (error) {
    throw error
  }
}

const cleanupTags = (prefix) => {
  return new Promise((resolve, reject) => {
    const queue = async.queue((tag, done) => {
      github.delete(`/repos/${GITHUB_REPOSITORY}/git/${tag.ref}`).then((response) => {
        console.log(`Deleted tag: ${tag.ref}`)
        done()
      }).catch(error => reject(error))
    })
    queue.drain(() => {
      console.log(`Cleanup Finished`)
      resolve()
    })
    queue.push(existingTags)
  })
}

async function run() {
  try {
    const path = process.env.INPUT_PREFIX ? `.${process.env.INPUT_PREFIX}_build_number` : '.build_number';
    const prefix = process.env.INPUT_PREFIX ? `${process.env.INPUT_PREFIX}-` : '';

    // See if we've already generated a build number
    if (fs.existsSync(path)) {
        const buildNumber = fs.readFileSync(path);
        console.log(`Build number already generated: ${buildNumber}`);
        fs.writeFileSync(process.env.GITHUB_ENV, `BUILD_NUMBER=${buildNumber}`);
        console.log(`echo "build_number::${buildNumber}" >> $GITHUB_OUTPUT`);
        exec.exec('echo', [
          `"build_number::${buildNumber}"`,
          `>>`,
          `$GITHUB_OUTPUT`,
        ])
        return;
    }

    // Check environment vars
    for (let envVar of ['INPUT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA']) {
      if (!process.env[envVar]) {
          const error = new Error(`ERROR: Environment variable ${envVar} is not defined.`)
          throw error
      }
    }

    // Get last build number
    const lastBuildNumber = await getLastBuildNumber(prefix);

    if (lastBuildNumber > 0) {
      console.log(`Previous Build Number: ${lastBuildNumber}`);
    } else {
      console.log(`No previous builds found`)
    }

    // Calculate new build number
    const buildNumber = lastBuildNumber + 1
    console.log(`New Build Number: ${buildNumber}`)

    // Save build number
    await saveBuildNumber(prefix, buildNumber)

    //Setting the output and a environment variable to new build number...
    fs.writeFileSync(process.env.GITHUB_ENV, `BUILD_NUMBER=${buildNumber}`);
    console.log(`echo "build_number::${buildNumber}" >> $GITHUB_OUTPUT`);
    exec.exec('echo', [
      `"build_number::${buildNumber}"`,
      `>>`,
      `$GITHUB_OUTPUT`,
    ])
    
    // Save to file
    fs.writeFileSync(path, buildNumber.toString());

    console.log(`Cleaning up tags...`)
    await cleanupTags(prefix)

  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run();