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
      // const context = github.context;  
      const appName = getAppName()
      const chart = getChart()
      const values = getValues()
      
      core.debug(`param: appName = "${appName}"`);
      core.debug(`param: chart = "${chart}"`);
      core.debug(`param: values = "${values}"`);
      
      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()
      
      // Write values file
      await writeFile("./values.yml", values);

      // Setup command options and arguments.
      const args = [
          "upgrade",
          appName,
          chart,
          "--install",
          "--values",
          "values.yml"
      ];

      process.env.HELM_HOME = "/root/.helm/"
  
      await exec.exec('helm', args);
      
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }
  
  run();