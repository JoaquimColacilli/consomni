; ════════════════════════════════════════════════════════════════
;  Consomni — include NSIS custom (electron-builder lo toma solo por
;  estar en build/installer.nsh). Agrega una página con el checkbox
;  "Crear acceso directo en el escritorio" (MARCADO por default) y crea
;  u omite el .lnk del escritorio según la elección.
;  El acceso directo del MENÚ INICIO lo sigue creando electron-builder
;  (createStartMenuShortcut por default). Acá sólo manejamos el escritorio
;  (en el yml: nsis.createDesktopShortcut=false → no hay duplicado).
;
;  OJO: este include se compila DOS veces (instalador y desinstalador).
;  Las funciones de la página sólo se referencian en el instalador, así que
;  TODO lo del instalador va dentro de !ifndef BUILD_UNINSTALLER (si no, NSIS
;  tira "function not referenced" en el pass del uninstaller → warning-as-error).
; ════════════════════════════════════════════════════════════════
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var ConsomniDtDialog
  Var ConsomniDtCheckbox
  Var ConsomniCreateDesktop

  ; Default = marcado (por si la página no llegara a mostrarse / instalación silenciosa).
  !macro customInit
    StrCpy $ConsomniCreateDesktop ${BST_CHECKED}
  !macroend

  ; Página propia, después de la de elegir carpeta de instalación.
  !macro customPageAfterChangeDir
    Page custom ConsomniDtPageCreate ConsomniDtPageLeave
  !macroend

  Function ConsomniDtPageCreate
    nsDialogs::Create 1018
    Pop $ConsomniDtDialog
    ${If} $ConsomniDtDialog == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Consomni se va a instalar. Elegí si querés un acceso directo en el escritorio."
    Pop $0
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Crear acceso directo en el escritorio"
    Pop $ConsomniDtCheckbox
    ${NSD_Check} $ConsomniDtCheckbox        ; marcado por default
    nsDialogs::Show
  FunctionEnd

  Function ConsomniDtPageLeave
    ${NSD_GetState} $ConsomniDtCheckbox $ConsomniCreateDesktop
  FunctionEnd

  ; Crear el acceso del escritorio sólo si quedó tildado.
  !macro customInstall
    ${If} $ConsomniCreateDesktop == ${BST_CHECKED}
      CreateShortcut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
  !macroend
!endif

; Al desinstalar, sacar el acceso del escritorio si existe (corre en el pass del uninstaller).
!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
!macroend
