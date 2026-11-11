@echo off
rem Rebuilds the US channel lineup and guide, then serves them to the TV on port 8787.
rem Keep this window open while you watch. Close it to stop the server.
cd /d "%~dp0"
node tools\build-lineup.mjs %*
node tools\serve-guide.mjs
