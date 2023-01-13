# Stony Brook University's Lung Slide Analyses

The three lung slide docker images are:

1. sbubmi/quip_til_classification:latest (used for analyses 1 and 2)
2. sbubmi/quip_nucleus_segmentation:latest (used for analysis 3)
3. sbubmi/quip_lung_tumor_segmentation:latest (used for analysis 4)

Docker images 1 and 2 have been tested with AWS g4dn instance types and NDPI slide images. Some Docker images may work with g5 instances, but not all of them. The CUDA version must match what was compiled into the Docker image by Stony Brook. This works best on batches of four slide images and using attached local storage, because the disk IO is high. I've been using Ubuntu 22.04 on the g4dn.2xlarge instance type, because the first part of each analysis maxes out 8 cpus with its 8 threads. It also provides enough local storage to process four slide images simultaneously.

Things to look out for:

- Slide images cannot have spaces in their names.
- The Docker process will never end on some errors. It will keep retrying until manually stopped.
- Analysis #2 should be run after #1. It can reuse some of the data calculatated during Analysis #1.
- Analyses #1, #3, and #4 can be run in parallel on different machines.

# Prepare the AWS g4dn instance for the analysis jobs

1. Find and format the instance's local storage, and mount it at `/data`

```sh
        sudo mkfs -t ext4 /dev/nvme1n1
        sudo mkdir -p /data
        sudo mount /dev/nvme1n1 /data
```

2. Install Docker and GPU drivers

```sh
        sudo apt-get remove docker docker-engine docker.io containerd runc
        sudo apt-get update
        sudo apt-get install -y ca-certificates curl gnupg lsb-release

        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
            sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

        sudo apt-get update
        sudo apt-get install -y \
            docker-ce \
            docker-ce-cli \
            containerd.io \
            docker-compose-plugin \
            awscli \
            nvme-cli \
            ubuntu-drivers-common \
            nvidia-driver-470 \
            nvidia-utils-470
        sudo usermod -aG docker ubuntu
```

4. Install nvidia-docker and reboot to load drivers (or use modprobe)

```sh
        distribution=$(. /etc/os-release;echo $ID$VERSION_ID) \
            && curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg \
            && curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
                    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
                    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

        sudo apt-get update
        sudo apt-get install -y nvidia-docker2 nvidia-container-toolkit
        sudo shutdown -r now # you may be able to use modprobe to avoid the reboot.  untested
```

# Analysis steps overview

## 1. Tumor Infiltrating Lymphocyte (TIL) using VGG16 model

1. Create the directory to be mapped to the Docker container and copy the slide images

```sh
        sudo mkdir -p /data/til/svs
        # copy four images to /data/til/svs
```

2. Create the analysis artifacts

```sh
        nvidia-docker run --rm \
            --name=vgg16 \
            -v /data/til:/data \
            -e MODEL_CONFIG_FILENAME='config_vgg-mix_test_ext.ini' \
            -e CUDA_VISIBLE_DEVICES='0' \
            -e HEATMAP_VERSION_NAME='lym_vgg-mix_prob' \
            -e LYM_PREDICTION_BATCH_SIZE=32 \
            sbubmi/quip_til_classification:latest svs_2_heatmap.sh
```

3. Copy the analysis artifacts to S3 for loading into viewer
   i. Copy contents of /data/til/output to S3 under a prefix named like "til_vgg16"
   ii. Save the contents of /data/til for use by the next analysis (#2)

## 2. Tumor Infiltrating Lymphocyte (TIL) using Inception model

1. Remove patch artifacts and clear output directory from TIL VGG16 analysis

```sh
        sudo find /data/til/patches \
            -type f -name "patch-level-color.txt" -delete
        sudo find /data/til/patches \
            -type f -name "patch-level-lym.txt" -delete
        sudo rm -rf /data/til/output
        sudo mkdir /data/til/output
```

2. Create the analysis artifacts

```sh
        nvidia-docker run --rm \
            --name=inceptionv4 \
            -v /data/til:/data \
            -e MODEL_CONFIG_FILENAME='config_incep-mix_test_ext.ini' \
            -e CUDA_VISIBLE_DEVICES='0' \
            -e HEATMAP_VERSION_NAME='lym_incep-mix_probability' \
            -e LYM_PREDICTION_BATCH_SIZE=32 \
            sbubmi/quip_til_classification:latest svs_2_heatmap.sh
```

3. Copy the analysis artifacts to S3 for loading into viewer
   i. Copy contents of /data/til/output to S3 under a prefix named like "til_inception"
   ii. Nothing else needs to be saved

## 3. Nucleus Segmentation

1. Create the directory to be mapped to the Docker container and copy the slide images

```sh
        sudo mkdir -p /data/nucleus_seg/svs
        # copy four images to /data/nucleus_seg/svs
```

2. Create the analysis artifacts

```sh
        sudo nvidia-docker run --rm \
            --name=nucleusseg \
            -v /data/nucleus_seg:/data/wsi_seg_local_data \
            -e CUDA_VISIBLE_DEVICES='0' \
            sbubmi/quip_nucleus_segmentation run_wsi_seg.sh
```

3. Copy the analysis artifacts to S3 for loading into viewer
   i. Remove the slide images `sudo rm -rf /data/nucleus_seg/svs`
   i. Copy contents of /data/nucleus_seg to S3 under a prefix named like "nucleus_seg"

## 3. Lung Tumor Segmentation _UNTESTED_

This image is untested. All of the other images had to be updated by Stony Brook to support \*.ndpi files, and this image was updated when all of the other ones were, so it ought to work.

1. Create the directory to be mapped to the Docker container and copy the slide images

```sh
        sudo mkdir -p /data/tumor_seg/svs
        # copy four images to /data/tumor_seg/svs
```

2. Create the analysis artifacts

```sh
        sudo nvidia-docker run --rm \
            --name=tumorseg \
            -v /data/tumor_seg:/data \
            sbubmi/quip_lung_tumor_segmentation svs_2_heatmap.sh
```

3. Copy the analysis artifacts to S3 for loading into viewer
   i. Copy contents of /data/tumor_seg/output to S3 under a prefix named like "tumor_seg"
