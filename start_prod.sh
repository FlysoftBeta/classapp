#!/bin/sh
rm -rf ./data.db* ./blobs ./backups
cp ./prod.db ./data.db
npm run dev
