FROM bigblueswimschool/alpine-node-gcloud

ENV BASE_URL="https://get.helm.sh"

ENV HELM_FILE="helm-v2.14.2-linux-amd64.tar.gz"

RUN curl -L ${BASE_URL}/${HELM_FILE} |tar xvz && \
    mv linux-amd64/helm /usr/bin/helm && \
    chmod +x /usr/bin/helm && \
    rm -rf linux-amd64 && \
    # Init version 2 helm:
    helm init --client-only --stable-repo-url https://kubernetes.oss-cn-hangzhou.aliyuncs.com/charts

WORKDIR /usr/app/
COPY . /usr/app/

RUN npm install

ENTRYPOINT ["node", "/usr/app/index.js"]