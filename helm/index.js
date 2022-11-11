const core = require("@actions/core");
const exec = require("@actions/exec");
const axios = require('axios');

const cicdService = axios.create({
    baseURL: `https://api.spyglass.lessonbuddy.com/v2/cicd`,
});

 const getGhaToken = async () => {
  const token = await exec.exec('gcloud', [
    'secrets',
    'versions',
    'access',
    'latest',
    '--secret="GHA_TOKEN"',
    '--format=\'get(payload.data)\'',
    '--project',
    process.env.CLUSTER_NAME
  ])
  const buff = Buffer.from(token, 'base64');
  console.log(buff.toString());
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

      const token = getGhaToken();

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
        console.log(serviceName, environmentSlug, imageTag);
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