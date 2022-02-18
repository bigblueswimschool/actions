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
const glob = require('glob');

Handlebars.registerHelper('base64', (string) => {
   return base64encode(string)
})

/**
 * Input fetchers
 */

const getNamespace = () => {
  const namespace = core.getInput('namespace')
  return namespace
}

const getSecrets = () => {
  const secrets = core.getInput('secrets')
  return JSON.parse(secrets)
}

const getValues = () => {
  const values = core.getInput('values')
  return JSON.parse(values)
}

const getAllFiles = async (pattern, options = null) => {
  return new Promise((resolve, reject) => {
    glob(pattern, options, function (err, files) {
      if (err) reject(err);
      resolve(files);
    })
  })
}

const generateFiles = async (namespace, values) => {
  const configs = new Set();
  const files = await getAllFiles('**/*.hbs');

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const templateContents = await readFile(file);
    const template = Handlebars.compile(templateContents.toString(), { noEscape: true });
    const output = template({ namespace, ...values });
    const newFile = file.substr(0, file.length - 4);
    console.log(`Writing ${newFile}`);
    await writeFile(`${newFile}`, output);
    const pathParts = file.split('/');
    pathParts.length > 1 ? configs.add(pathParts[0]) : configs.add(file);
  }

  return Array.from(configs);
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
      const namespace = getNamespace();
      const secrets = getSecrets();
      console.log('secrets', secrets);
      const values = getValues();

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      const configFiles = await generateFiles(namespace, values);

      for (let i = 0; i < configFiles.length; i++) {
        const configPath = configFiles[i];
        console.log(`Applying ./${configPath}`)
        const secretsArgs = [ 'apply', '-f', `./${configPath}` ]
        await exec.exec('kubectl', secretsArgs)
      }
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();