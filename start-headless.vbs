' Modo headless: coleta e sincroniza em segundo plano, SEM abrir painel/navegador.
' Requer sync.enabled = true no config.json (ou config.local.json).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If sh.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
	MsgBox "Node.js nao foi encontrado. Instale em https://nodejs.org", vbExclamation, "ccusage headless"
	WScript.Quit 1
End If
sh.Run "cmd /c node ""server.js"" --headless", 0, False
