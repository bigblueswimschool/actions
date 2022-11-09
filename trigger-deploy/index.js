const core = require("@actions/core");
const axios = require('axios');

const cicdService = axios.create({
    baseURL: `https://api.spyglass.lessonbuddy.com/v2/cicd`,
});

/**
 * Run executes the deployment trigger.
 */
async function run() {
  try {
    const serviceName = core.getInput('serviceName')
    const environmentSlug = core.getInput('environmentSlug')
    const imageTag = core.getInput('imageTag')
    const token = core.getInput('ghaToken')
    console.log(`Deploying ${serviceName} ${imageTag} to ${environmentSlug}`)

    await cicdService.post(`/services/deploy`,
      { serviceName, environmentSlug, imageTag },
      { headers: { Authorization: `Bearer ${token}`} })
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run();