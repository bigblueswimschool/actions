const core = require("@actions/core");
const exec = require("@actions/exec");
const axios = require('axios');

const cicdService = axios.create({
    baseURL: `https://api.spyglass.lessonbuddy.com/v2/cicd`,
});

const authGCloud = () => {
  return exec.exec('gcloud', [
    'auth',
    'activate-service-account',
    '--key-file',
    `${process.env.GOOGLE_APPLICATION_CREDENTIALS}`
  ])
}


const getGhaToken = async () => {
  let token = ''

  const options = {};
  options.listeners = {
    stdout: (data) => {
      token += data.toString()
    }
  }
  await exec.exec('gcloud', [
    'secrets',
    'versions',
    'access',
    'latest',
    '--secret',
    'GHA_TOKEN',
    '--project',
    'lessonbuddy-production'
  ], options)
  token = token.trim()
  console.log('token', token)
  return token;
}

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      let jsonValues = core.getInput('jsonValues')
      const values = JSON.parse(jsonValues)
      const clusterName = process.env.CLUSTER_NAME
      const serviceName = values.name
      const imageTag = values.version

      let environmentSlug = null;

      await authGCloud();
      const token = await getGhaToken();

      switch (clusterName) {
        case 'develop-cluster':
          environmentSlug = 'develop';
        break;

        case 'production-cluster-1':
        case 'demo-cluster-1':
          environmentSlug = 'production';
        break;
      }
      
      if (serviceName && environmentSlug && imageTag) {
        console.log(`Deploying ${serviceName} ${imageTag} to ${environmentSlug}`)

        await cicdService.post(`/services/deploy`,
          { serviceName, environmentSlug, imageTag },
          { headers: { Authorization: `Bearer ${token}`} })

      } else {
        const error = new Error('Missing deployment information')
        core.error(error);
        core.setFailed(error.message);
      }  
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }
  
  run();