#!/bin/bash
# Start script for data-service that survives shell exit
cd /app/mini-services/data-service
exec python3 -u -c "
import uvicorn
uvicorn.run('main:app', host='0.0.0.0', port=3031, reload=False, log_level='info')
"
