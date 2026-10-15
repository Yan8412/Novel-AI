Option Explicit

Dim shell, scriptDir, command
Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /d /c call """ & scriptDir & "\start-novel-studio.cmd"" --service"
shell.Run command, 0, False
