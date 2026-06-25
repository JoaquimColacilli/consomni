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

  ; Crear el acceso del escritorio si quedó tildado (instalación fresca) O si es un update.
  ; En un auto-update el desinstalador VIEJO (sin el guard de abajo) ya borró el .lnk, así que
  ; acá lo (re)creamos sí o sí (${isUpdated}) para que el ícono no desaparezca, y refrescamos el
  ; shell con SHChangeNotify (si no, aunque el .lnk exista, el escritorio no lo redibuja → "no vuelve").
  !macro customInstall
    ${If} $ConsomniCreateDesktop == ${BST_CHECKED}
    ${OrIf} ${isUpdated}
      CreateShortcut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  !macroend

  ; Página final con "Ejecutar Consomni" que SÍ abre la app. El default de electron-builder
  ; usa StdUtils.ExecShellAsUser (pensado para des-elevar desde un instalador admin); en una
  ; instalación per-user sin elevar suele NO lanzar nada. Acá la corremos con Exec directo,
  ; que es confiable para per-user. (customFinishPage reemplaza la página final default.)
  !macro customFinishPage
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION ConsomniRunApp
    !insertmacro MUI_PAGE_FINISH
  !macroend

  ; OJO: en una Function los ${...} se resuelven al PARSEAR (acá, antes de common.nsh),
  ; así que NO sirve ${APP_EXECUTABLE_FILENAME} (define tardío). ${PRODUCT_FILENAME} es un
  ; define de línea de comando → disponible desde el arranque. El exe es <PRODUCT_FILENAME>.exe.
  Function ConsomniRunApp
    SetOutPath "$INSTDIR"
    Exec '"$INSTDIR\${PRODUCT_FILENAME}.exe"'
  FunctionEnd
!endif

; Al desinstalar, sacar el acceso del escritorio si existe (corre en el pass del uninstaller).
; ⚠️ SÓLO en una desinstalación REAL: durante un auto-update electron-builder corre este
; desinstalador con --keep-shortcuts (${isKeepShortcuts} == true) para que los accesos directos
; SOBREVIVAN al update (igual que el borrado built-in del template, guardado por el mismo predicado).
; Sin este guard, cada update borraba el ícono del escritorio (bug histórico).
!macro customUnInstall
  ${ifNot} ${isKeepShortcuts}
    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
  ${endIf}
!macroend
