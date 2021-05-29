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
  const args = [ 'container', 'clusters', 'get-credentials' ]

  if (process.env.CLUSTER_NAME) args.push(process.env.CLUSTER_NAME)
  if (process.env.COMPUTE_ZONE) args.push('--zone', process.env.COMPUTE_ZONE)
  if (process.env.COMPUTE_REGION) args.push('--region', process.env.COMPUTE_REGION)
  if (process.env.PROJECT_ID) args.push('--project', process.env.PROJECT_ID)

  return exec.exec('gcloud', args)
}

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      // const context = github.context;
      const appName = getAppName()
      const namespace = getNamespace()
      // const chart = getChart()
      // const values = getValues()

      core.debug(`param: appName = "${appName}"`);
      core.debug(`param: namespace = "${namespace}"`);
      // core.debug(`param: chart = "${chart}"`);
      // core.debug(`param: values = "${values}"`);

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      const args = [ 'cluster-info' ]

      await exec.exec('kubectl', args);

      // Write values file
      // await writeFile("./values.yml", values);

      // Setup command options and arguments.
      // const args = [
      //     "upgrade",
      //     appName,
      //     chart,
      //     "--install",
      //     "--namespace",
      //     namespace,
      //     "--values",
      //     "values.yml",
      //     "--debug",
      //     "--dry-run"
      // ];

      // process.env.HELM_HOME = "/root/.helm/"

      // await exec.exec('helm', args);

    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();