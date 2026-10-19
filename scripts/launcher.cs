// fraziym-mcp launcher: tiny Windows shim that runs the Node CLI
// (dist/cli/index.js) with the caller's stdio attached, so MCP clients get a
// real .exe to spawn instead of a .cmd shim. Built with the Windows-bundled
// C# compiler (csc.exe); Node >= 24 must be on PATH (the package requires it).

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class Program
{
    private static int Main(string[] args)
    {
        string exePath = System.Reflection.Assembly.GetExecutingAssembly().Location;
        if (String.IsNullOrEmpty(exePath))
        {
            exePath = Environment.GetCommandLineArgs()[0];
        }
        string binDir = Path.GetDirectoryName(exePath);
        string root = Path.GetDirectoryName(binDir);
        string cli = Path.Combine(root, "dist", "cli", "index.js");
        if (!File.Exists(cli))
        {
            Console.Error.WriteLine("[fraziym-mcp] Cannot find " + cli);
            Console.Error.WriteLine("[fraziym-mcp] Reinstall @fraziym/mcp (the exe must sit next to the package's dist/).");
            return 1;
        }

        string node = FindNode();
        if (node == null)
        {
            Console.Error.WriteLine("[fraziym-mcp] Node.js >= 24 not found on PATH.");
            Console.Error.WriteLine("[fraziym-mcp] Install Node, or set FRAZIYM_MCP_NODE to node.exe.");
            return 1;
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = Quote(cli) + BuildArgs(args);
        psi.UseShellExecute = false;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = Environment.CurrentDirectory;

        Process child = new Process();
        child.StartInfo = psi;
        child.Start();

        Stream stdin = Console.OpenStandardInput();
        Stream stdout = Console.OpenStandardOutput();
        Stream stderr = Console.OpenStandardError();

        Thread tIn = new Thread(delegate()
        {
            try
            {
                Stream childIn = child.StandardInput.BaseStream;
                byte[] buf = new byte[8192];
                int n;
                while ((n = stdin.Read(buf, 0, buf.Length)) > 0)
                {
                    childIn.Write(buf, 0, n);
                    childIn.Flush();
                }
            }
            catch { }
            try { child.StandardInput.BaseStream.Close(); } catch { }
        });
        tIn.IsBackground = true;
        tIn.Start();

        Thread tOut = new Thread(delegate()
        {
            try
            {
                Stream childOut = child.StandardOutput.BaseStream;
                byte[] buf = new byte[8192];
                int n;
                while ((n = childOut.Read(buf, 0, buf.Length)) > 0)
                {
                    stdout.Write(buf, 0, n);
                    stdout.Flush();
                }
            }
            catch { }
            try { stdout.Flush(); } catch { }
        });
        tOut.IsBackground = true;
        tOut.Start();

        Thread tErr = new Thread(delegate()
        {
            try
            {
                Stream childErr = child.StandardError.BaseStream;
                byte[] buf = new byte[8192];
                int n;
                while ((n = childErr.Read(buf, 0, buf.Length)) > 0)
                {
                    stderr.Write(buf, 0, n);
                    stderr.Flush();
                }
            }
            catch { }
            try { stderr.Flush(); } catch { }
        });
        tErr.IsBackground = true;
        tErr.Start();

        child.WaitForExit();
        tOut.Join(2000);
        tErr.Join(2000);
        return child.ExitCode;
    }

    private static string FindNode()
    {
        string env = Environment.GetEnvironmentVariable("FRAZIYM_MCP_NODE");
        if (!String.IsNullOrEmpty(env) && File.Exists(env))
        {
            return env;
        }

        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!String.IsNullOrEmpty(pathVar))
        {
            string[] dirs = pathVar.Split(';');
            for (int i = 0; i < dirs.Length; i++)
            {
                string dir = dirs[i].Trim().Trim('"');
                if (dir.Length == 0)
                {
                    continue;
                }
                string candidate = Path.Combine(dir, "node.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string[] fallbacks = new string[]
        {
            Path.Combine(pf, "nodejs", "node.exe"),
            Path.Combine(pf86, "nodejs", "node.exe")
        };
        for (int i = 0; i < fallbacks.Length; i++)
        {
            if (File.Exists(fallbacks[i]))
            {
                return fallbacks[i];
            }
        }
        return null;
    }

    private static string BuildArgs(string[] args)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            sb.Append(' ');
            sb.Append(Quote(args[i]));
        }
        return sb.ToString();
    }

    // Standard Windows argument quoting (backslash-doubling before quotes).
    private static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
        {
            return s;
        }
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            sb.Append('\\', backslashes);
            backslashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
