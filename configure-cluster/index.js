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
  console.log(files);

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const templateContents = await readFile(file);
    const template = Handlebars.compile(templateContents.toString(), { noEscape: true });
    const output = template({ namespace, ...values });
    const newFile = file.substr(0, file.length - 4);
    console.log(`Writing ${newFile}`);
    await writeFile(`${newFile}`, output);
    const pathParts = file.split('/');
    pathParts.length > 1 ? configs.add(`${pathParts[0]}/`) : configs.add(file);
  }

  return configs;
}

const generateRabbitMQ = async (namespace, values) => {
   const files = await readDir('./rabbitmq')
   const templateFiles = files.filter(o => o.substr(-3, 3) === 'hbs')
   // Process Templates
   for (let i = 0; i < templateFiles.length; i++) {
      const file = templateFiles[i]
      const templateContents = await readFile(`./rabbitmq/${file}`)
      const template = Handlebars.compile(templateContents.toString(), { noEscape: true })
      const output = template({ namespace, ...values })
      const newFile = file.substr(0, file.length - 4)
      console.log(`Writing ./rabbitmq/${newFile}...`)
      await writeFile(`./rabbitmq/${newFile}`, output)
   }
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
      const namespace = getNamespace();
      const values = getValues();

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      console.log(process.env);
      const configFiles = await generateFiles(namespace, values);
      console.log(configFiles);

      // await generateRabbitMQ(namespace, values)
      // await generateSecrets(namespace, values)

      console.log('Applying Secrets...')
      // const secretsArgs = [ 'apply', '-f', './secrets' ]
      // await exec.exec('kubectl', secretsArgs)

      console.log('Applying RabbitMQ...')
      // const rabbitmqArgs = [ 'apply', '-f', './rabbitmq' ]
      // await exec.exec('kubectl', rabbitmqArgs)

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