FROM node:20-alpine

WORKDIR /usr/app/
COPY . /usr/app/

RUN yarn

ENTRYPOINT ["node", "/usr/app/index.js"]