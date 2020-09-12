async function run() {
  try {
    const path = '.build_number';
    const offset = process.env.INPUT_OFFSET ? parseInt(process.env.INPUT_OFFSET) : 0;

    //See if we've already generated the build number and are in later steps...
    if (fs.existsSync(path)) {
        let buildNumber = fs.readFileSync(path);
        console.log(`Build number already generated in earlier jobs, using build number ${buildNumber}`);
        console.log(`::set-env name=BUILD_NUMBER::${buildNumber}`);
        console.log(`::set-output name=build_number::${buildNumber}`);
        return;
    }

    for (let varName of ['GITHUB_RUN_NUMBER']) {
      if (!process.env[varName]) {
          fail(`ERROR: Environment variable ${varName} is not defined.`);
      }
    }

    const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER)
    const buildNumber = runNumber + offset

    console.log(`Calculated Build number: ${buildNumber}`);
    console.log(`::set-env name=BUILD_NUMBER::${buildNumber}`);
    console.log(`::set-output name=build_number::${buildNumber}`);

    fs.writeFileSync(path, nextBuildNumber.toString());
    
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run();