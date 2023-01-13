#!/usr/bin/env zx

/*
This script requires node and Google's zx (https://github.com/google/zx)
See documentation folder.

This script is meant to be used on an AWS g4dn that was configured with
the prep_machine_g4.sh script.
*/

// todo: more documentation

const queueName = argv["queue"]

const bucket = "REPLACE_ME"

if (!queueName) {
    console.log("missing --queue argument")
    await $`exit 1`
}

//$.verbose = false
const mounts = await $`mount`
//$.verbose = true

const hasDataMount = mounts.stdout
    .split("\n")
    .some(o => o.toLowerCase().includes("/data"))

if (!hasDataMount) {
    await $`sudo mkfs -t ext4 /dev/nvme1n1`
    await $`sudo mkdir -p /data`
    await $`sudo mount /dev/nvme1n1 /data`
    await takeOwnership("/data")
}

const tissue = "breast"
const bucketFQN = `s3://${bucket}`
const queuePrefix = "breast_queue/"
const processedDirPrefix = "breast_queue_processed"

const s3SourceFilesPrefix = `breast_queue/${queueName}`
const s3TargetFilesPrefix = `output/${tissue}/${queueName}`

// pull latest images
await $`docker pull sbubmi/quip_til_classification:latest`
await $`docker pull sbubmi/quip_brca_tumor_segmentation:latest`
await $`docker pull sbubmi/quip_nucleus_segmentation:latest`



await takeOwnership("/data")
// get all files in s3 source dir
const allFiles = await getAllFilesInDirectoryS3(bucket, s3SourceFilesPrefix)
const chunksOf4Files = chunk(allFiles, 4)
for (const files of chunksOf4Files) {
    const batch = {
        batchDir: s3SourceFilesPrefix,
        name: queueName,
        outputS3Prefix: `${bucketFQN}/${s3TargetFilesPrefix}`,
        chunk: new Date().toISOString()
    }

    console.log("copy input slide images from s3 to local directory")
    await fs.ensureDir("/data/svs")
    await fs.emptyDir("/data/svs")
    for (const file of files) {
        const src = `s3://winship-pathomics/${file}`
        await $`aws s3 cp ${src} /data/svs`
    }

    // don't run in parallel.  the GPU runs out of RAM
    await runTilVgg16(batch)
    await runTilInception(batch)
    await runBrcaTumorSegmentation(batch)
    await runNucleusSegmentation(batch)

    // mark files as processed
    for (const file of files) {
        const processedDir = `${processedDirPrefix}/${batch.name}/`
        await touchS3(bucket, `${processedDir}${file}.processed`)
    }
}


//await $`sudo shutdown -h now`


async function getUnprocessedFiles(bucket, batch) {
    const ndpiFiles = await getAllFilesInDirectoryS3(bucket, batch.batchDir)
    const processedDir = `${processedDirPrefix}/${batch.name}/`
    const processedFiles = (await getAllFilesInDirectoryS3(bucket, processedDir))
        .map(o => o.slice(0, o.length - ".processed".length))
        .filter(o => o.toLowerCase().endsWith(".ndpi"))
    
    return ndpiFiles
        .filter(o => !processedFiles.includes(o))
}


async function runTilVgg16(chunkedBatch) {
    console.log("TIL VGG16 - start")
    
    const rootDir = "/data/til"
    await fs.ensureDir(rootDir)
    await takeOwnership(rootDir)
    await fs.emptyDir(rootDir)

    console.log("TIL VGG16 - copying images")
    //await fs.copy("/data/svs", `${rootDir}/svs`)
    await copyAllFilesByLinking("/data/svs", `${rootDir}/svs`)
    await fs.ensureFile(`${rootDir}/output/tel_start_${new Date().toISOString()}.txt`)

    console.log("TIL VGG16 - analyzing images")
    await $`nvidia-docker run --rm \
        --name=vgg16 \
        -v ${rootDir}:/data \
        -e MODEL_CONFIG_FILENAME='config_vgg-mix_test_ext.ini' \
        -e CUDA_VISIBLE_DEVICES='0' \
        -e HEATMAP_VERSION_NAME='lym_vgg-mix_prob' \
        -e LYM_PREDICTION_BATCH_SIZE=32 \
        sbubmi/quip_til_classification:latest svs_2_heatmap.sh`
    await takeOwnership(rootDir)

    await fs.ensureFile(`${rootDir}/output/tel_end_${new Date().toISOString()}.txt`)

    console.log("TIL VGG16 - sync output to s3")
    const outputPath = `${rootDir}/output`
    const outputS3Target = `${chunkedBatch.outputS3Prefix}/${chunkedBatch.chunk}/til_vgg16`
    await $`aws s3 sync ${outputPath} ${outputS3Target}`

    // don't clean up folder.  it's used by the TIL inception analysis next

    console.log("TIL VGG16 - complete")
}


async function runTilInception(chunkedBatch) {
    console.log("TIL Inception - start")
    
    const rootDir = "/data/til"
    await takeOwnership(rootDir)

    await fs.emptyDir(`${rootDir}/output`)

    console.log("TIL Inception - removing patch artifacts from vgg16")
    const patchesDir = `${rootDir}/patches`
    await $`find ${patchesDir} -type f -name "patch-level-color.txt" -delete`
    await $`find ${patchesDir} -type f -name "patch-level-lym.txt" -delete`

    await fs.ensureFile(`${rootDir}/output/tel_start_${new Date().toISOString()}.txt`)

    console.log("TIL Inception - analyzing images")
    await $`nvidia-docker run --rm \
    --name=inceptionv4 \
    -v ${rootDir}:/data \
    -e MODEL_CONFIG_FILENAME='config_incep-mix_test_ext.ini' \
    -e CUDA_VISIBLE_DEVICES='0' \
    -e HEATMAP_VERSION_NAME='lym_incep-mix_probability' \
    -e LYM_PREDICTION_BATCH_SIZE=32 \
    sbubmi/quip_til_classification:latest svs_2_heatmap.sh`
    await takeOwnership(rootDir)

    await fs.ensureFile(`${rootDir}/output/tel_end_${new Date().toISOString()}.txt`)

    console.log("TIL Inception - sync output to s3")
    const outputPath = `${rootDir}/output`
    const outputS3Target = `${chunkedBatch.outputS3Prefix}/${chunkedBatch.chunk}/til_inception`
    await $`aws s3 sync ${outputPath} ${outputS3Target}`

    // clean up
    await fs.emptyDir(rootDir)

    console.log("TIL Inception - complete")
}


async function runBrcaTumorSegmentation(chunkedBatch) {
    console.log("BRCA Tumor Seg - start")
    
    const rootDir = "/data/brca"
    await takeOwnership(rootDir)
    await fs.emptyDir(rootDir)

    console.log("BRCA Tumor Seg - copying images")
    //await fs.copy("/data/svs", `${rootDir}/svs`)
    await copyAllFilesByLinking("/data/svs", `${rootDir}/svs`)
    await fs.ensureFile(`${rootDir}/output/tel_start_${new Date().toISOString()}.txt`)

    console.log("BRCA Tumor Seg - analyzing images")
    await $`sudo nvidia-docker run --rm \
        --name=tumorseg \
        -v ${rootDir}:/data \
        sbubmi/quip_brca_tumor_segmentation svs_2_heatmap.sh`
    await takeOwnership(rootDir)


    await fs.ensureFile(`${rootDir}/output/tel_end_${new Date().toISOString()}.txt`)

    console.log("BRCA Tumor Seg - sync output to s3")
    const outputPath = `${rootDir}/output`
    const outputS3Target = `${chunkedBatch.outputS3Prefix}/${chunkedBatch.chunk}/brca_tumor_seg`
    await $`aws s3 sync ${outputPath} ${outputS3Target}`

    // clean up
    await fs.emptyDir(rootDir)

    console.log("BRCA Tumor Seg - complete")
}

async function runNucleusSegmentation(chunkedBatch) {
    console.log("Nucleus Segmentation - start")

    // this is different than the other analyses.
    // remove the svs folder and sync all of the contents to s3
    // there is no ouput folder
    
    const rootDir = "/data/nucleus_seg"
    await takeOwnership(rootDir)
    await fs.emptyDir(rootDir)

    console.log("Nucleus Segmentation - copying images")
    //await fs.copy("/data/svs", `${rootDir}/svs`)
    await copyAllFilesByLinking("/data/svs", `${rootDir}/svs`)
    await fs.ensureFile(`${rootDir}/tel_start_${new Date().toISOString()}.txt`)

    console.log("Nucleus Segmentation - analyzing images")
    await $`sudo nvidia-docker run --rm \
        --name=nucleusseg \
        -v ${rootDir}:/data/wsi_seg_local_data \
        -e CUDA_VISIBLE_DEVICES='0' \
        sbubmi/quip_nucleus_segmentation run_wsi_seg.sh`
    await takeOwnership(rootDir)

    await fs.ensureFile(`${rootDir}/tel_end_${new Date().toISOString()}.txt`)

    console.log("Nucleus Segmentation - sync output to s3")
    await fs.remove(`${rootDir}/svs`)
    const outputPath = rootDir
    const outputS3Target = `${chunkedBatch.outputS3Prefix}/${chunkedBatch.chunk}/nucleus_seg`
    await $`aws s3 sync ${outputPath} ${outputS3Target}`

    // clean up
    await fs.emptyDir(rootDir)

    console.log("Nucleus Segmentation - complete")
}


async function takeOwnership(path) {
    try {
        await $`sudo chown -R ubuntu ${path}`
    }
    catch { }
}

async function touchS3(bucket, path) {
    await $`aws s3api put-object --bucket ${bucket} --key ${path}`
}

async function getAllFilesInDirectoryS3(bucket, prefix) {
    const safePrefix = prefix.endsWith("/")
        ? prefix
        : `${prefix}/`
    return (await $`aws s3api list-objects-v2 --bucket ${bucket} --prefix ${safePrefix} --query "Contents[].{Key: Key}" --output text`)
        .stdout
        .split("\n")
        .map(o => o?.trim())
        .filter(o => !!o && !o.endsWith("/"))
}

function chunk(arr, size) {
    return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
        arr.slice(i * size, i * size + size)
    )
}

async function copyAllFilesByLinking(srcDir, tgtDir) {
    const srcDirSafe = srcDir.endsWith("/")
    ? srcDir.substr(0, srcDir.length - 1)
    : srcDir
    const tgtDirSafe = tgtDir.endsWith("/")
    ? tgtDir.substr(0, tgtDir.length - 1)
    : tgtDir
    await fs.ensureDir(tgtDirSafe)
    const files = await fs.readdir(srcDirSafe)
    for (const file of files) {
        const srcFile = `${srcDirSafe}/${file}`
        const tgtFile = `${tgtDirSafe}/${file}`
        await fs.link(srcFile, tgtFile)
    }
}
