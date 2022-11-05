FROM bigblueswimschool/alpine-node-gcloud

WORKDIR /usr/app/
COPY . /usr/app/

RUN npm install

ENTRYPOINT ["node", "/usr/app/index.js"]