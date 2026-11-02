@echo off
setlocal EnableExtensions EnableDelayedExpansion
title OpenCode + Cloudflare WARP

rem ===========================================================================
rem  opencode-warp baslatici
rem
rem  Kullanim:
rem    baslat.bat              -> WARP'i dogrular, eklentiyi baglar, hazir bekler
rem    baslat.bat yeni-ip      -> once WARP IP'sini dondurur, sonra dogrular
rem    baslat.bat opencode     -> dogrulamadan sonra OpenCode'u baslatir
rem    baslat.bat yeni-ip opencode
rem
rem  Bu dosya trafigi WARP'a SOKMAZ. Cihaz trafigi WARP'in kendi modu ile
rem  tunelden gider (Mode: WarpWithDnsOverHttps). Burada yapilan: dogrulamak.
rem ===========================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "WARPCLI=C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe"
set "PLUGINS=%USERPROFILE%\.config\opencode\plugins"
set "TRACE=%TEMP%\opencode-warp-trace.txt"
set "STATUSF=%TEMP%\opencode-warp-status.txt"
set "WANT_ROTATE=0"
set "WANT_OPENCODE=0"

:PARSE_ARGS
if "%~1"=="" goto ARGS_DONE
if /i "%~1"=="yeni-ip"  set "WANT_ROTATE=1"
if /i "%~1"=="rotate"   set "WANT_ROTATE=1"
if /i "%~1"=="opencode" set "WANT_OPENCODE=1"
if /i "%~1"=="yardim"   goto HELP
if /i "%~1"=="help"     goto HELP
if /i "%~1"=="/?"       goto HELP
shift
goto PARSE_ARGS
:ARGS_DONE

echo.
echo  ============================================================
echo   OpenCode  x  Cloudflare WARP
echo  ============================================================
echo.

rem ---------------------------------------------------------------- 1) eklenti
echo  [1/4] Eklenti baglantisi
if not exist "%PLUGINS%" mkdir "%PLUGINS%" >nul 2>&1
if exist "%PLUGINS%\opencode-warp\index.js" (
  echo        ok - eklenti bagli: %PLUGINS%\opencode-warp
  goto PLUGIN_DONE
)
if exist "%PLUGINS%\opencode-warp" (
  echo        UYARI: "%PLUGINS%\opencode-warp" var ama index.js yok.
  echo        O klasoru silip bu dosyayi tekrar calistir.
  goto PLUGIN_DONE
)
mklink /J "%PLUGINS%\opencode-warp" "%ROOT%" >nul 2>&1
if errorlevel 1 (
  echo        UYARI: baglanti olusturulamadi.
  echo        Elle yap: opencode.json  ^-^>  "plugins": ["%ROOT:\=\\%"]
) else (
  echo        ok - eklenti baglandi: %PLUGINS%\opencode-warp
)
:PLUGIN_DONE

rem ------------------------------------------------------------------ 2) warp-cli
echo  [2/4] warp-cli
if exist "%WARPCLI%" goto HAVE_CLI
where warp-cli >nul 2>&1
if errorlevel 1 (
  echo        HATA: warp-cli bulunamadi.
  echo        Cloudflare One Client ^(WARP^) kurulu mu?
  goto FAIL
)
set "WARPCLI=warp-cli"
:HAVE_CLI
for /f "delims=" %%V in ('""%WARPCLI%" --version" 2^>nul') do set "WV=%%V"
echo        ok - %WV%

rem ------------------------------------------------------------------- 3) baglanti
echo  [3/4] Tunel baglantisi
"%WARPCLI%" status > "%STATUSF%" 2>&1
set "CONNECTED=0"
findstr /i /c:"Disconnected" "%STATUSF%" >nul 2>&1
if errorlevel 1 (
  findstr /i /c:"Connected" "%STATUSF%" >nul 2>&1
  if not errorlevel 1 set "CONNECTED=1"
)
if "%CONNECTED%"=="1" (
  echo        ok - zaten bagli
  goto LINK_DONE
)
echo        bagli degil, baglaniyor...
"%WARPCLI%" connect > "%STATUSF%" 2>&1
call :WAIT_ONLINE
if errorlevel 1 (
  echo        HATA: tunel acilmadi. warp-cli ciktisi:
  type "%STATUSF%"
  goto FAIL_HINT
)
echo        ok - tunel acildi
:LINK_DONE

rem ------------------------------------------------------- 4) cikis dogrulama
echo  [4/4] Cikis dogrulamasi
call :WAIT_ONLINE
if errorlevel 1 goto NOT_WARP

echo        ok - warp=%WARP%
echo        cikis IP : %IP%
echo        konum    : %LOC% / %COLO%
echo.

if "%WANT_ROTATE%"=="1" (
  echo  [*] IP donduruluyor...
  "%WARPCLI%" disconnect >nul 2>&1
  call :SLEEP 2
  "%WARPCLI%" connect >nul 2>&1
  call :WAIT_ONLINE
  if errorlevel 1 goto NOT_WARP
  echo        yeni IP : %IP%   ^(%LOC% / %COLO%^)
  echo.
)

echo  ------------------------------------------------------------
echo   HAZIR - trafik Cloudflare WARP uzerinden cikiyor.
echo   Simdi OpenCode'u acabilirsin.
echo  ------------------------------------------------------------
echo.

if "%WANT_OPENCODE%"=="1" goto LAUNCH
pause
exit /b 0

:LAUNCH
where opencode >nul 2>&1
if errorlevel 1 (
  echo  UYARI: opencode PATH'te yok. Kendin acabilirsin.
  pause
  exit /b 1
)
echo  [*] OpenCode baslatiliyor...
echo.
opencode
exit /b %ERRORLEVEL%

rem =========================================================== alt rutinler
:FETCH
rem Trace endpoint'ini oku; WARP / IP / LOC / COLO degiskenlerini doldur.
set "WARP="
set "IP="
set "LOC="
set "COLO="
del "%TRACE%" >nul 2>&1
curl.exe -s --max-time 8 -H "cache-control: no-store" "https://www.cloudflare.com/cdn-cgi/trace" -o "%TRACE%" 2>nul
if not exist "%TRACE%" (
  powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 'https://www.cloudflare.com/cdn-cgi/trace').Content } catch { }" > "%TRACE%" 2>nul
)
if not exist "%TRACE%" exit /b 1
for /f "usebackq tokens=1,* delims==" %%A in ("%TRACE%") do (
  if /i "%%A"=="warp" set "WARP=%%B"
  if /i "%%A"=="ip"   set "IP=%%B"
  if /i "%%A"=="loc"  set "LOC=%%B"
  if /i "%%A"=="colo" set "COLO=%%B"
)
if not defined WARP exit /b 1
exit /b 0

:WAIT_ONLINE
rem En fazla 6 deneme (~30 sn) boyunca warp=on bekle.
set /a __try=0
:WAIT_LOOP
set /a __try+=1
call :FETCH
if /i "%WARP%"=="on"   exit /b 0
if /i "%WARP%"=="plus" exit /b 0
if %__try% GEQ 6 exit /b 1
call :SLEEP 4
goto WAIT_LOOP

:SLEEP
set "S=%~1"
if "%S%"=="" set "S=2"
timeout /t %S% /nobreak >nul 2>&1
if errorlevel 1 ping -n %S% 127.0.0.1 >nul 2>&1
exit /b 0

rem =========================================================== hata yollari
:NOT_WARP
echo.
echo  HATA: cikis WARP uzerinden gorunmuyor  ^(warp=%WARP%^).
if defined IP echo        gorunen IP: %IP%   ^(%LOC% / %COLO%^)
call :FAIL_HINT
exit /b 1

:FAIL_HINT
echo.
echo  Kontrol listesi:
echo    - Cloudflare One Client bagli mi?        warp-cli status
echo    - Mod dogru mu?                          warp-cli settings
echo      beklenen: Mode = WarpWithDnsOverHttps
echo    - Split tunnel'da hedef alan adi hariç tutulmus mu?
echo      warp-cli tunnel host list   ^(bos olmali^)
echo    - Kurumsal profil / MDM bir mod zorluyor olabilir.
echo.
goto FAIL

:HELP
echo.
echo  baslat.bat              WARP'i dogrula, hazir bekle
echo  baslat.bat yeni-ip      once IP dondur, sonra dogrula
echo  baslat.bat opencode     dogrulamadan sonra OpenCode'u baslat
echo  baslat.bat yeni-ip opencode
echo.
exit /b 0

:FAIL
echo.
pause
exit /b 1
