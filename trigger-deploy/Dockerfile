FROM bigblueswimschool/alpine-node-16-gcloud

WORKDIR /usr/app/
COPY . /usr/app/

RUN npm install

ENTRYPOINT ["node", "/usr/app/index.js"]