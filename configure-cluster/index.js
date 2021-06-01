const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const writeFile = util.promisify(fs.writeFile);
const readDir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const YAML = require('json-to-pretty-yaml');
const Handlebars = require('handlebars');

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
  return namespace
}

const getValues = () => {
   const values = core.getInput('values')
   return JSON.parse(values)
}

const generateConfigs = async (namespace, values) => {
   const files = await readDir('.')
   console.log(files)

   const templateFiles = files.filter(o => o.substr(-3, 3) === 'hbs')
   console.log(templateFiles)
   for (let i = 0; i < templateFiles.length; i++) {
      const file = templateFiles[i]
      const templateContents = await readFile(file)
      console.log(templateContents)
      const template = Handlebars.compile(templateContents)
      const output = template.compile({ namespace, ...values })
      console.log(output)
   }
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
      const namespace = getNamespace();
      const values = getValues();

      core.debug(`param: appName = "${appName}"`);

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      await generateConfigs(namespace, values)

    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();