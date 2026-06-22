# Claude — Múltiples perfiles con un solo CLI

Un ejecutable. Tres carpetas de config. Cero interferencia entre cuentas.

---

## Cómo funciona

La variable de entorno `CLAUDE_CONFIG_DIR` le dice al ejecutable `claude.exe` en qué carpeta guardar todo: settings, plugins, skills, memoria de proyectos e historial.

Cambiando esa variable antes de ejecutar `claude`, cada alias opera con su propia configuración aislada — como si fueran instalaciones separadas.

```
C:\Users\TuNombre\
├── .claude\          ← claude (default)
│   ├── settings.json
│   ├── skills\
│   └── projects\
│
├── .claude-max\      ← claude-max
│   ├── settings.json
│   ├── skills\
│   └── projects\
│
└── .claude-team\     ← claude-team
    ├── settings.json
    ├── skills\
    └── projects\
```

---

## Setup paso a paso

### 01 — Crear las carpetas

```powershell
mkdir "$HOME\.claude-max"
mkdir "$HOME\.claude-team"
```

> Si ya tenés `~/.claude` configurado, podés copiar su `settings.json` como punto de partida.

---

### 02 — Abrir el PowerShell profile

El profile es un script que PowerShell ejecuta al arrancar. `$PROFILE` ya sabe dónde vive.

```powershell
# Crear el profile si no existe
if (!(Test-Path $PROFILE)) {
    New-Item -Force -Path $PROFILE
}

# Abrirlo en tu editor
notepad $PROFILE
```

---

### 03 — Agregar las funciones

Pegá esto al final del archivo:

```powershell
function claude-max {
    $env:CLAUDE_CONFIG_DIR = "$HOME\.claude-max"
    claude @args
}

function claude-team {
    $env:CLAUDE_CONFIG_DIR = "$HOME\.claude-team"
    claude @args
}
```

---

### 04 — Recargar el profile

El dot-source (`.`) ejecuta el profile en la sesión actual sin abrir una terminal nueva.

```powershell
. $PROFILE
```

---

### 05 — Verificar

```powershell
claude        # usa ~/.claude
claude-max    # usa ~/.claude-max
claude-team   # usa ~/.claude-team

# Ver qué carpeta está activa ahora mismo
$env:CLAUDE_CONFIG_DIR
```

---

## ⚠️ Comportamiento a tener en cuenta

Después de llamar `claude-max`, la variable `CLAUDE_CONFIG_DIR` queda seteada en esa sesión de PowerShell. Si luego llamás `claude` directo (sin alias), va a seguir apuntando a `.claude-max` hasta que cierres la terminal o la limpies con:

```powershell
Remove-Item Env:CLAUDE_CONFIG_DIR
```

En la práctica no es un problema si siempre usás los alias — pero conviene saberlo.
