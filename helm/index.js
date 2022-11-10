const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const writeFile = util.promisify(fs.writeFile);
const YAML = require('json-to-pretty-yaml');

/**
 * Input fetchers
 */
const getAppName = () => {
  const repository = process.env.GITHUB_REPOSITORY
  const appNameInput = core.getInput('appName')
  const appName = appNameInput || repository.split('/')[1]

  return appName
}

const getNamespace = () => {
  const namespace = core.getInput('namespace')
  return namespace || 'default'
}

const getChart = () => {
  const chart = core.getInput('chart', { required: true })
  return `/usr/app/charts/${chart}`
}

const getValues = () => {
  let yamlValues = core.getInput('values')
  let jsonValues = core.getInput('jsonValues')

  if (yamlValues) {
    console.log('yaml values provided')
    return yamlValues
  } else if (jsonValues) {
    console.log('json values provided')
    jsonValues = jsonValues || {}
    yamlValues = YAML.stringify(JSON.parse(jsonValues))
    return yamlValues
  }
  return null
}

/**
 * authGCloud() activates the service account using the ENV var
 */
const authGCloud = () => {
  return exec.exec('gcloud', [
    'auth',
    'activate-service-account',
    '--key-file',
    `${process.env.GOOGLE_APPLICATION_CREDENTIALS}`
  ])
}

/**
 * getKubeCredentials() fetches the cluster credentials
 */
const getKubeCredentials = () => {
  return exec.exec('gcloud', [
    'container',
    'clusters',
    'get-credentials',
    process.env.CLUSTER_NAME,
    '--zone',
    process.env.COMPUTE_ZONE,
    '--project',
    process.env.PROJECT_ID
  ])
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