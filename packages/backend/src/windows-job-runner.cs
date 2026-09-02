using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class ClayWindowsJobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint SYNCHRONIZE = 0x00100000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;

        var result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static int Run(uint ownerPid, string executable, string[] arguments)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        IntPtr information = IntPtr.Zero;
        var process = new PROCESS_INFORMATION();
        bool assigned = false;
        try
        {
            owner = OpenProcess(SYNCHRONIZE, false, ownerPid);
            if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint ownerState = WaitForSingleObject(owner, 0);
            if (ownerState == WAIT_FAILED)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (ownerState == WAIT_OBJECT_0)
                throw new InvalidOperationException("Clay owner exited before Codex launch.");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int informationSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            information = Marshal.AllocHGlobal(informationSize);
            Marshal.StructureToPtr(limits, information, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                    information, (uint)informationSize))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            var commandLine = new StringBuilder(Quote(executable));
            foreach (string argument in arguments)
            {
                commandLine.Append(' ');
                commandLine.Append(Quote(argument));
            }
            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

            if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED, IntPtr.Zero, Environment.CurrentDirectory,
                    ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            assigned = true;

            if (ResumeThread(process.hThread) == UInt32.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            uint wait = WaitForMultipleObjects(
                2, new[] { process.hProcess, owner }, false, INFINITE);
            if (wait == WAIT_FAILED)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (wait == WAIT_OBJECT_0 + 1) return 72;
            if (wait != WAIT_OBJECT_0)
                throw new InvalidOperationException("Unexpected process wait result.");

            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return unchecked((int)exitCode);
        }
        catch
        {
            if (process.hProcess != IntPtr.Zero && !assigned)
                TerminateProcess(process.hProcess, 70);
            throw;
        }
        finally
        {
            int terminationError = 0;
            if (assigned && job != IntPtr.Zero && !TerminateJobObject(job, 1))
                terminationError = Marshal.GetLastWin32Error();
            if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (owner != IntPtr.Zero) CloseHandle(owner);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (terminationError != 0) throw new Win32Exception(terminationError);
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("Clay Job Object runner requires an owner PID and executable.");
            return 64;
        }
        uint ownerPid;
        if (!UInt32.TryParse(args[0], out ownerPid) || ownerPid == 0)
        {
            Console.Error.WriteLine("Clay Job Object runner received an invalid owner PID.");
            return 64;
        }
        try
        {
            var childArgs = new string[args.Length - 2];
            Array.Copy(args, 2, childArgs, 0, childArgs.Length);
            return Run(ownerPid, args[1], childArgs);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Clay Job Object runner failed: " + error.Message);
            return 70;
        }
    }
}
