' Inicia o painel ccusage em segundo plano (sem janela) e abre o navegador.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

' Verifica Node.js antes de tentar (evita falha silenciosa)
If sh.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
	MsgBox "Node.js nao foi encontrado nesta maquina." & vbCrLf & vbCrLf & _
		"Instale em https://nodejs.org (versao LTS) e rode este atalho de novo." & vbCrLf & vbCrLf & _
		"Se o Node ja esta instalado, abra o start-debug.bat para ver o erro detalhado.", _
		vbExclamation, "ccusage Dashboard"
	WScript.Quit 1
End If

sh.Run "cmd /c node ""server.js""", 0, False
WScript.Sleep 1500
sh.Run "http://localhost:8384"
