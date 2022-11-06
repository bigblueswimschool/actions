FROM bigblueswimschool/alpine-node-16-gcloud

WORKDIR /usr/app/
COPY . /usr/app/

RUN yarn

ENTRYPOINT ["node", "/usr/app/index.js"]