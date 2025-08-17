@echo off
echo ======================================
echo VirtualME AI-Engine API Testing Script
echo ======================================
echo.

REM Create test results directory
if not exist "test-results" mkdir test-results
cd test-results

REM Clear previous results
del /q *.json 2>nul
del /q *.log 2>nul

echo [1/10] Testing Root Endpoint (New JSON Format)...
curl -s "http://localhost:4001/" > 01-root-endpoint.json
echo     Results saved to: 01-root-endpoint.json

echo [2/10] Testing Health Endpoint...
curl -s "http://localhost:4001/health" > 02-health-endpoint.json
echo     Results saved to: 02-health-endpoint.json

echo [3/10] Testing V1 API - New User OAuth...
curl -s "http://localhost:4001/v1/auth/google/newuser456" > 03-v1-new-user-oauth.json
echo     Results saved to: 03-v1-new-user-oauth.json

echo [4/10] Testing V1 API - Existing User OAuth...
curl -s "http://localhost:4001/v1/auth/google/testuser123" > 04-v1-existing-user-oauth.json
echo     Results saved to: 04-v1-existing-user-oauth.json

echo [5/10] Testing Legacy Redirect (Backward Compatibility)...
curl -s "http://localhost:4001/auth/google/testuser123" > 05-legacy-redirect.json
echo     Results saved to: 05-legacy-redirect.json

echo [6/10] Testing Error Handling (Invalid Token)...
curl -s -X POST "http://localhost:4001/v1/chat" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer invalid_token" ^
  -d "{\"message\": \"test\"}" > 06-error-handling.json
echo     Results saved to: 06-error-handling.json

echo [7/10] Testing Validation Error (Missing Message)...
curl -s -X POST "http://localhost:4001/v1/chat" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0dXNlcjEyMyIsImVtYWlsIjoiZmFyYXp1ZGRpbm1vaGFtbWVkMDVAZ21haWwuY29tIiwiaWF0IjoxNzU1Mzg3MzY2LCJleHAiOjE3NTU0NzM3NjZ9.919fMuO1CDlySPdq-bRDtaVMtEdsbI-cPOK4TogJmno" ^
  -d "{}" > 07-validation-error.json
echo     Results saved to: 07-validation-error.json

echo [8/10] Testing Enhanced Calendar Ingestion...
curl -s -X POST "http://localhost:4001/v1/ingest" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0dXNlcjEyMyIsImVtYWlsIjoiZmFyYXp1ZGRpbm1vaGFtbWVkMDVAZ21haWwuY29tIiwiaWF0IjoxNzU1Mzg3MzY2LCJleHAiOjE3NTU0NzM3NjZ9.919fMuO1CDlySPdq-bRDtaVMtEdsbI-cPOK4TogJmno" ^
  -d "{\"dataType\": \"calendar\", \"options\": {\"futureMonths\": 6}}" > 08-calendar-ingestion.json
echo     Results saved to: 08-calendar-ingestion.json

echo [9/10] Testing AI Chat with Enhanced Context...
curl -s -X POST "http://localhost:4001/v1/chat" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0dXNlcjEyMyIsImVtYWlsIjoiZmFyYXp1ZGRpbm1vaGFtbWVkMDVAZ21haWwuY29tIiwiaWF0IjoxNzU1Mzg3MzY2LCJleHAiOjE3NTU0NzM3NjZ9.919fMuO1CDlySPdq-bRDtaVMtEdsbI-cPOK4TogJmno" ^
  -d "{\"message\": \"What are my upcoming meetings this week?\"}" > 09-ai-chat-enhanced.json
echo     Results saved to: 09-ai-chat-enhanced.json

echo [10/10] Testing Profile with Enhanced Stats...
curl -s "http://localhost:4001/v1/profile/testuser123" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0dXNlcjEyMyIsImVtYWlsIjoiZmFyYXp1ZGRpbm1vaGFtbWVkMDVAZ21haWwuY29tIiwiaWF0IjoxNzU1Mzg3MzY2LCJleHAiOjE3NTU0NzM3NjZ9.919fMuO1CDlySPdq-bRDtaVMtEdsbI-cPOK4TogJmno" > 10-profile-enhanced.json
echo     Results saved to: 10-profile-enhanced.json

echo.
echo ======================================
echo Testing Complete! 
echo ======================================
echo All results saved in: test-results/
echo.
echo Files created:
dir /b *.json
echo.
echo To view results:
echo   type 01-root-endpoint.json
echo   type 02-health-endpoint.json
echo   etc...
echo.
echo Or open the test-results folder in File Explorer
cd ..