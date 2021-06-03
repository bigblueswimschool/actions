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
const { base64encode } = require('nodejs-base64');

Handlebars.registerHelper('base64', (string) => {
   return base64encode(string)
})

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

const generateSecrets = async (namespace, values) => {
   const files = await readDir('./secrets')
   const templateFiles = files.filter(o => o.substr(-3, 3) === 'hbs')
   // Process Templates
   for (let i = 0; i < templateFiles.length; i++) {
      const file = templateFiles[i]
      const templateContents = await readFile(`./secrets/${file}`)
      const template = Handlebars.compile(templateContents.toString(), { noEscape: true })
      const output = template({ namespace, ...values })
      const newFile = file.substr(0, file.length - 4)
      console.log(`Writing ./secrets/${newFile}...`)
      await writeFile(`./secrets/${newFile}`, output)
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

      const configs = await generateSecrets(namespace, values)

      console.log('Applying Secrets...')
      const secretsArgs = [ 'apply', '-f', './secrets' ]
      await exec.exec('kubectl', secretsArgs)

      console.log('Applying RabbitMQ...')
      const rabbitmqArgs = [ 'apply', '-f', './rabbitmq' ]
      await exec.exec('kubectl', rabbitmqArgs)

      // for (let i = 0; i < configs.length; i++) {
      //    const config = configs[i]
      //    const args = [ 'apply', '-f', config ]
      //    await exec.exec('kubectl', args)
      // }

    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();