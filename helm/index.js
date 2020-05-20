const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");

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
  return 'default'
}

const getChart = () => {
  const chart = core.getInput('chart', { required: true })
  return `/usr/app/charts/${chart}`
}

const getValues = () => {
  let values = core.getInput('values')
  values = values || {}
  return values
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
      const namespace = getNamespace()
      const chart = getChart()
      const values = getValues()

      // const namespace = getInput("namespace", required);
      // const chart = `/usr/app/charts/${getInput("chart", required)}`;
      // const values = getValues(getInput("values"));
      
      core.debug(`param: appName = "${appName}"`);
      core.debug(`param: namespace = "${namespace}"`);
      core.debug(`param: chart = "${chart}"`);
      core.debug(`param: values = "${values}"`);
      
      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()
      
      // Setup command options and arguments.
      const args = [
          "list"
      ];

      process.env.HELM_HOME = "/root/.helm/"
  
      await exec.exec('helm', args);
      
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }
  
  run();