const core = require("@actions/core");
const exec = require("@actions/exec");
const axios = require('axios');

const cicdService = axios.create({
    baseURL: `https://api.spyglass.lessonbuddy.com/v2/cicd`,
});

/**
 * triggerDeploy() trigger deployment from cicd
 */
const triggerDeploy = async () => {
  const serviceName = core.getInput('serviceName')
  const environmentSlug = core.getInput('environmentSlug')
  const imageTag = core.getInput('imageTag')
  const token = core.getInput('ghaToken')

  const response = await cicdService.post(`/gha-config`, { serviceName, environmentName: environmentSlug, imageTag }, { headers: { Authorization: `Bearer ${token}`} }).catch(err => console.log(err));
  const config = response.data;
  return config
}

/**
 * Run executes the helm deployment.
 */
async function run() {
  try {
    const deploy = await triggerDeploy();
    console.log(deploy);
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run();