const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const writeFile = util.promisify(fs.writeFile);
const YAML = require('json-to-pretty-yaml');

const getDeployment = (name, namespace, repository, version) => {
  const deployment = {
    "apiVersion": "apps/v1",
    "kind": "Deployment",
    "metadata": {
       "labels": {
          "app": name
       },
       "name": name,
       "namespace": namespace
    },
    "spec": {
       "replicas": 1,
       "revisionHistoryLimit": 10,
       "selector": {
          "matchLabels": {
             "app": name
          }
       },
       "strategy": {
          "rollingUpdate": {
             "maxSurge": 2,
             "maxUnavailable": 0
          },
          "type": "RollingUpdate"
       },
       "minReadySeconds": 5,
       "template": {
          "metadata": {
             "labels": {
                "app": name
             }
          },
          "spec": {
             "containers": [
                {
                   "image": `${repository}/${name}:${version}`,
                   "imagePullPolicy": "IfNotPresent",
                   "tty": true,
                   "stdin": true,
                   "name": name,
                   "ports": [
                      {
                         "containerPort": 3000
                      }
                   ],
                   "envFrom": null,
                   "resources": {
                      "requests": {
                         "cpu": "50m",
                         "memory": "256Mi"
                      }
                   },
                   "volumeMounts": [
                      {
                         "name": "google-cloud",
                         "mountPath": "/usr/config/google.json",
                         "subPath": "googleCloud.json",
                         "readOnly": true
                      }
                   ]
                }
             ],
             "dnsPolicy": "ClusterFirst",
             "restartPolicy": "Always",
             "schedulerName": "default-scheduler",
             "securityContext": {},
             "terminationGracePeriodSeconds": 30,
             "volumes": [
                {
                   "name": "google-cloud",
                   "secret": {
                      "secretName": "google-cloud"
                   }
                }
             ]
          }
       }
    }
  }

  yaml = YAML.stringify(deployment)
  return yaml
}
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

const getRepository = () => {
  const repository = core.getInput('repository')
  return repository
}

const getVersion = () => {
  const version = core.getInput('version')
  return version
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
      const repository = getRepository()
      const version = getVersion()
      // const chart = getChart()
      // const values = getValues()

      core.debug(`param: appName = "${appName}"`);
      core.debug(`param: namespace = "${namespace}"`);
      core.debug(`param: repository = "${repository}"`);
      core.debug(`param: version = "${version}"`);
      // core.debug(`param: chart = "${chart}"`);
      // core.debug(`param: values = "${values}"`);

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      const args = [ 'cluster-info' ]

      await exec.exec('kubectl', args);

      const deployment = getDeployment(appName, namespace, repository, version);

      // Write values file
      await writeFile("./deployment.yml", deployment);

      const deployArgs = [ '-f', 'deployment.yml' ]

      await exec.exec('kubectl', deployArgs);

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