FROM node:10.16-alpine

ENV BASE_URL="https://get.helm.sh"

ENV HELM_FILE="helm-v2.16.1-linux-amd64.tar.gz"

RUN apk add --no-cache ca-certificates \
    --repository http://dl-3.alpinelinux.org/alpine/edge/community/ \
    jq curl bash nodejs aws-cli && \
    # Install helm version 2:
    curl -L ${BASE_URL}/${HELM_FILE} |tar xvz && \
    mv linux-amd64/helm /usr/bin/helm && \
    chmod +x /usr/bin/helm && \
    rm -rf linux-amd64 && \
    # Init version 2 helm:
    helm init --client-only

ENV PYTHONPATH "/usr/lib/python3.8/site-packages/"

COPY . /usr/app/

RUN npm install

ENTRYPOINT ["node", "/usr/app/index.js"]