#!/bin/sh
set -e
rm -f ./build/deploy/data.db*
cp -f ./prod.db ./build/deploy/data.db
cd ./build/deploy
CLASSAPP_PORTS=8080,8081,8082,8083,8084,8085,8086,8088 sh ./start.sh
