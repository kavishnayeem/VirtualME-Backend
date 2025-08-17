# VirtualME AI-Engine API Testing Script (PowerShell)
Write-Host "======================================" -ForegroundColor Green
Write-Host "VirtualME AI-Engine API Testing Script" -ForegroundColor Green  
Write-Host "======================================" -ForegroundColor Green
Write-Host ""

# Create test results directory
if (-not (Test-Path "test-results")) {
    New-Item -ItemType Directory -Name "test-results" | Out-Null
}
Set-Location "test-results"

# Clear previous results
Remove-Item "*.json" -ErrorAction SilentlyContinue
Remove-Item "*.log" -ErrorAction SilentlyContinue

# Test configurations
$baseUrl = "http://localhost:4001"
$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0dXNlcjEyMyIsImVtYWlsIjoiZmFyYXp1ZGRpbm1vaGFtbWVkMDVAZ21haWwuY29tIiwiaWF0IjoxNzU1Mzg3MzY2LCJleHAiOjE3NTU0NzM3NjZ9.919fMuO1CDlySPdq-bRDtaVMtEdsbI-cPOK4TogJmno"

function Test-Endpoint {
    param($testName, $fileName, $url, $method = "GET", $body = $null, $headers = @{})
    
    Write-Host "[$testName] Testing..." -ForegroundColor Yellow
    
    try {
        if ($method -eq "GET") {
            $response = Invoke-RestMethod -Uri $url -Method $method -Headers $headers
        } else {
            $response = Invoke-RestMethod -Uri $url -Method $method -Body $body -ContentType "application/json" -Headers $headers
        }
        
        # Pretty print JSON
        $response | ConvertTo-Json -Depth 10 | Out-File -FilePath $fileName -Encoding UTF8
        Write-Host "    ✅ Success - Results saved to: $fileName" -ForegroundColor Green
        
        # Show brief summary
        if ($response.success) {
            Write-Host "    📊 Status: SUCCESS - $($response.message)" -ForegroundColor Cyan
        } else {
            Write-Host "    ❌ Status: ERROR - $($response.message)" -ForegroundColor Red
        }
    }
    catch {
        $errorResponse = @{
            error = $_.Exception.Message
            statusCode = $_.Exception.Response.StatusCode.value__
            timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
        }
        $errorResponse | ConvertTo-Json -Depth 5 | Out-File -FilePath $fileName -Encoding UTF8
        Write-Host "    ❌ Error - Results saved to: $fileName" -ForegroundColor Red
    }
    Write-Host ""
}

# Test 1: Root Endpoint
Test-Endpoint "1/10" "01-root-endpoint.json" "$baseUrl/"

# Test 2: Health Endpoint  
Test-Endpoint "2/10" "02-health-endpoint.json" "$baseUrl/health"

# Test 3: V1 New User OAuth
Test-Endpoint "3/10" "03-v1-new-user-oauth.json" "$baseUrl/v1/auth/google/newuser456"

# Test 4: V1 Existing User OAuth
Test-Endpoint "4/10" "04-v1-existing-user-oauth.json" "$baseUrl/v1/auth/google/testuser123"

# Test 5: Legacy Redirect
Test-Endpoint "5/10" "05-legacy-redirect.json" "$baseUrl/auth/google/testuser123"

# Test 6: Error Handling (Invalid Token)
Test-Endpoint "6/10" "06-error-handling.json" "$baseUrl/v1/chat" "POST" '{"message": "test"}' @{"Authorization" = "Bearer invalid_token"}

# Test 7: Validation Error
Test-Endpoint "7/10" "07-validation-error.json" "$baseUrl/v1/chat" "POST" '{}' @{"Authorization" = "Bearer $token"}

# Test 8: Enhanced Calendar Ingestion  
Test-Endpoint "8/10" "08-calendar-ingestion.json" "$baseUrl/v1/ingest" "POST" '{"dataType": "calendar", "options": {"futureMonths": 6}}' @{"Authorization" = "Bearer $token"}

# Test 9: AI Chat with Enhanced Context
Test-Endpoint "9/10" "09-ai-chat-enhanced.json" "$baseUrl/v1/chat" "POST" '{"message": "What are my upcoming meetings this week?"}' @{"Authorization" = "Bearer $token"}

# Test 10: Enhanced Profile
Test-Endpoint "10/10" "10-profile-enhanced.json" "$baseUrl/v1/profile/testuser123" "GET" $null @{"Authorization" = "Bearer $token"}

Write-Host "======================================" -ForegroundColor Green
Write-Host "Testing Complete!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host ""
Write-Host "📁 All results saved in: test-results/" -ForegroundColor Cyan
Write-Host ""
Write-Host "📄 Files created:" -ForegroundColor Yellow
Get-ChildItem "*.json" | ForEach-Object { Write-Host "   $($_.Name)" -ForegroundColor White }
Write-Host ""
Write-Host "🔍 To view results:" -ForegroundColor Yellow
Write-Host "   Get-Content 01-root-endpoint.json | ConvertFrom-Json | ConvertTo-Json -Depth 10" -ForegroundColor White
Write-Host "   Or open files in VS Code for syntax highlighting" -ForegroundColor White

Set-Location ".."