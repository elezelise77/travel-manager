# 여행 상황판 — 데스크톱 앱 (EXE 만들기)

Windows PC에서 아래 두 줄이면 설치 파일이 만들어집니다. Node.js 18 이상 필요합니다.

```bat
cd C:\Users\user\Travel-Manager\desktop-app
npm install
npm run dist
```

> `package.json` 이 있는 **desktop-app 폴더 안에서** 실행해야 합니다.
> `Travel-Manager` 폴더에서 바로 치면 `could not read package.json` 오류가 납니다.

`npm install` 은 처음 한 번만 오래 걸립니다 (Electron 내려받기, 3~5분 / 약 200MB).
경고 문구(`npm warn ...`)가 나와도 정상입니다.

## 결과물

`desktop-app\dist` 폴더에 두 개가 생깁니다.

| 파일 | 설명 |
|---|---|
| `TripBoard-Setup-1.2.0.exe` | 설치형. 바탕화면 바로가기까지 만들어 줍니다 |
| `TripBoard-Portable-1.2.0.exe` | 무설치. USB에 넣고 바로 실행 |

개발 중에 화면만 확인하려면 `npm start`.

## 파일 구성

```
main.js         앱 본체 — 창 띄우기, 여행방 목록 저장, 구글 웹앱과 통신, 백업 저장
preload.js      화면과 본체를 잇는 다리 (보안 경계)
ui/app.html     실제 화면 — 설치 마법사 + 툴바 + 업데이트 안내 + 여행 상황판
ui/guide.html   움직이는 설치 가이드 (앱 안에서 열림)
code/Code.gs    구글에 붙여넣을 최신 코드 (앱이 클립보드로 복사해 줍니다)
code/Index.html   〃
build/icon.ico  앱 아이콘
package.json    의존성과 빌드 설정
```

## 빌드 전에 꼭 할 것

앱은 `code/` 안의 파일을 클립보드로 복사해 주고, `code/Code.gs` 의 `APP_VERSION` 으로
업데이트 여부를 판단합니다. 웹앱 코드를 고쳤다면 빌드 전에 최신본을 넣어 주세요.

```bat
copy ..\google-apps-script\Code.gs     code\Code.gs
copy ..\google-apps-script\Index.html  code\Index.html
```

템플릿 시트 주소를 넣어두던 `ui/config.js` 는 더 이상 쓰지 않습니다.
설치는 구매자가 자기 계정에 **빈 시트를 만들어** 코드를 붙여넣는 방식입니다.

## 저장되는 것

- 여행방 목록(이름·주소)만 `%APPDATA%\trip-board\config.json` 에 저장됩니다.
- 지출·일정·사진 같은 실제 자료는 **사용자 본인 구글 계정**(시트와 드라이브)에만 있습니다.
- 비밀번호는 앱에 저장하지 않습니다. 백업받을 때 한 번 입력하고 끝입니다.

## 자주 나는 오류

| 증상 | 해결 |
|---|---|
| `could not read package.json` | `desktop-app` 폴더로 들어가서 실행 |
| `npm` 을 모른다고 나옴 | Node.js 설치 후 명령 프롬프트를 **새로 열기** |
| 빌드 중 다운로드 실패 | 회사 네트워크/백신이 막는 경우. 다른 네트워크에서 재시도 |
| 앱을 켰는데 흰 화면 | 웹 앱 주소가 `/exec` 로 끝나는지, 배포 액세스가 `모든 사용자`인지 확인 |
