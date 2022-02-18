const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const writeFile = util.promisify(fs.writeFile);
const YAML = require('json-to-pretty-yaml');

const getDeployment = (config) => {
  const { type, name, namespace, repository, version, secrets, readinessPath, apm } = config;

  // // Build configMaps
  // const envConfigs = configs.split(',').map(o => o.trim())
  // const envFrom = envConfigs.map(o => {
  //   return {
  //     "configMapRef": {
  //       "name": o
  //     }
  //   }
  // })

  // Build envrionment secrets
  const envSecrets = secrets.split(',').map(o => o.trim())
  const envFrom = envSecrets.map(o => {
    return {
      "secretRef": {
        "name": o
      }
    }
  })

  // Container Ports
  const containerPorts = [{ containerPort: 3000 }]
  if (type === 'nestjs') {
     containerPorts.push({ containerPort: 3001 })
  }

  // Volumes
  const volumeMounts = []
  const volumes = []

  // Load apm
  if (apm) {
    volumeMounts.push({
      "name": "elastic-apm-node",
      "mountPath": "/usr/config/elastic-apm-node.js",
      "subPath": "elastic-apm-node.js",
      "readOnly": true
    })

    volumes.push({
      "name": "elastic-apm-node",
      "secret": {
        "secretName": "elastic-apm-node"
      }
    })
  }


  // Load google cloud
  const googleIndex = secrets.findIndex(o => o === 'google')

  if (googleIndex >= 0) {
    volumeMounts.push({
      "name": "google-cloud",
      "mountPath": "/usr/config/google.json",
      "subPath": "googleCloud.json",
      "readOnly": true
    })

    volumes.push({
      "name": "google-cloud",
      "secret": {
         "secretName": "google-cloud"
      }
    })
  }

  // Deployment json
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
                   "ports": containerPorts,
                   "readinessProbe": {
                      "httpGet": {
                         "path": readinessPath,
                         "port": 3000
                      },
                      initialDelaySeconds: 5,
                      periodSeconds: 5,
                      successThreshold: 1
                   },
                   "envFrom": envFrom,
                   "resources": {
                      "requests": {
                         "cpu": "50m",
                         "memory": "256Mi"
                      }
                   },
                   "volumeMounts": volumeMounts
                }
             ],
             "dnsPolicy": "ClusterFirst",
             "restartPolicy": "Always",
             "schedulerName": "default-scheduler",
             "securityContext": {},
             "terminationGracePeriodSeconds": 30,
             "volumes": volumes
          }
       }
    }
  }

  yaml = YAML.stringify(deployment)
  return yaml
}

const getService = (config) => {
  const { type, name, namespace } = config;

  const ports = [
    {
      name: 'http',
      port: 3000,
      protocol: 'TCP',
      targetPort: 3000
    }
  ]

  if (type === 'nestjs') {
     ports.push({
       name: 'tcp',
       port: 3001,
       protocol: 'TCP',
       targetPort: 3001
     })
  }

  const service = {
    "apiVersion": "v1",
    "kind": "Service",
    "metadata": {
       "name": name,
       "namespace": namespace,
       "annotations": {
        "cloud.google.com/neg": `{ \"exposed_ports\": { \"3000\": { \"name\": \"${name}-${namespace}\" } } }`
       }
    },
    "spec": {
       "ports": ports,
       "selector": {
          "app": name
       },
       "type": "NodePort"
    }
  }
  yaml = YAML.stringify(service)
  return yaml
}
/**
 * Input fetchers
 */
const getInputConfig = () => {
  const repository = process.env.GITHUB_REPOSITORY
  const appNameInput = core.getInput('appName')
  const appName = appNameInput || repository.split('/')[1]
  const apm = core.getInput('apm')
  const secrets = core.getInput('secrets')
  const namespace = core.getInput('namespace')
  const readinessPath = core.getInput('readinessPath')
  const region = core.getInput('region')
  const repository = core.getInput('repository')
  const type = core.getInput('type')
  const version = core.getInput('version')

  return {
    apm: apm || true,
    secrets: secrets || '',
    name: appName,
    namespace: namespace || 'default',
    readinessPath: readinessPath || '/info',
    region: region || null,
    repository,
    type: type || 'express',
    version
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
      const inputConfig = getInputConfig();
      const { name, namespace, repository, version } = inputConfig;

      core.debug(`param: appName = "${name}"`);
      core.debug(`param: namespace = "${namespace}"`);
      core.debug(`param: repository = "${repository}"`);
      core.debug(`param: version = "${version}"`);

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      const args = [ 'cluster-info' ]

      await exec.exec('kubectl', args);

      // const deployment = getDeployment(inputConfig);
      // await writeFile("./deployment.yml", deployment);

      // const service = getService({ type, name: appName, namespace, region });
      // await writeFile("./service.yml", service);

      // const deployArgs = [ 'apply', '-f', 'deployment.yml' ]
      // await exec.exec('kubectl', deployArgs);

      // const serviceArgs = [ 'apply', '-f', 'service.yml' ]
      // await exec.exec('kubectl', serviceArgs);

    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();