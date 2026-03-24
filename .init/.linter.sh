#!/bin/bash
cd /tmp/kavia/workspace/code-generation/space-war-web-game-243857-243877/frontend_space_war_game
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

