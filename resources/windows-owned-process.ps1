param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory,
    [Parameter(Mandatory=$true)][string]$ArgumentsBase64,
    [Parameter(Mandatory=$true)][int]$ParentPid
)
$ErrorActionPreference = 'Stop'
try {
    # Node does not expose suspended CreateProcess/Job APIs. This owner passes its
    # raw standard handles to the CLI; PowerShell never reads or rewrites a prompt.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PerfCheckerOwnedProcess {
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public int cb; public IntPtr reserved, desktop, title;
        public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
        public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime,jobTime; public uint flags;
        public UIntPtr minimumWorkingSet,maximumWorkingSet; public uint activeLimit;
        public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long userTime,kernelTime,periodUserTime,periodKernelTime;
        public uint faults,totalProcesses,activeProcesses,terminatedProcesses;
    }
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting accounting,uint size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes,uint flags,IntPtr kind,IntPtr value,IntPtr size,IntPtr oldValue,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string executable,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint id);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint SearchPathW(string path,string name,string extension,int length,StringBuilder result,IntPtr part);

    static void Check(bool success,string operation) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(),operation);
    }
    static string Quote(string value) {
        var result=new StringBuilder("\""); int slashes=0;
        foreach (char character in value) {
            if (character=='\\') { slashes++; continue; }
            result.Append('\\',character=='\"' ? slashes*2+1 : slashes); slashes=0;
            result.Append(character);
        }
        result.Append('\\',slashes*2); return result.Append('"').ToString();
    }
    static string Resolve(string executable) {
        var result=new StringBuilder(32768);
        uint length=SearchPathW(null,executable,".exe",result.Capacity,result,IntPtr.Zero);
        if (length==0 || length>=result.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(),"Resolve native executable");
        return result.ToString();
    }
    static void StopAndWait(IntPtr job) {
        Check(TerminateJobObject(job,130),"Terminate owned Job");
        var deadline=Stopwatch.StartNew();
        while (true) {
            Accounting state;
            Check(QueryInformationJobObject(job,1,out state,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"Read owned Job accounting");
            if (state.activeProcesses==0) return;
            if (deadline.ElapsedMilliseconds>=10000) throw new TimeoutException("Owned Job cleanup did not finish within ten seconds.");
            Thread.Sleep(10);
        }
    }
    public static int Run(string executable,string[] arguments,string directory,int parentPid) {
        IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,attributes=IntPtr.Zero,handleList=IntPtr.Zero;
        var process=new ProcessInfo(); bool assigned=false,attributesInitialized=false;
        var standard=new IntPtr[] { GetStdHandle(-10),GetStdHandle(-11),GetStdHandle(-12) };
        var originalFlags=new uint[3]; int marked=0;
        Exception primary=null,cleanup=null; int exit=1;
        try {
            parent=OpenProcess(0x00101000,false,(uint)parentPid);
            if (parent==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Open owner parent");
            long parentCreated,ownerCreated,unusedExit,unusedKernel,unusedUser;
            Check(GetProcessTimes(parent,out parentCreated,out unusedExit,out unusedKernel,out unusedUser),"Read parent identity");
            Check(GetProcessTimes(GetCurrentProcess(),out ownerCreated,out unusedExit,out unusedKernel,out unusedUser),"Read owner identity");
            if (parentCreated>ownerCreated) throw new InvalidOperationException("The owner parent PID was reused after this launcher started.");
            if (WaitForSingleObject(parent,0)!=258) throw new InvalidOperationException("The owner parent has already stopped.");
            job=CreateJobObjectW(IntPtr.Zero,null);
            if (job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Create private Job");
            var limits=new ExtendedLimits(); limits.basic.flags=0x00002000; // KILL_ON_JOB_CLOSE; no breakaway.
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))),"Set private Job limits");
            for (int i=0;i<3;i++) {
                Check(GetHandleInformation(standard[i],out originalFlags[i]),"Read standard handle flags");
                Check(SetHandleInformation(standard[i],1,1),"Set inherited standard handle"); marked++;
            }
            IntPtr size=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            if (size==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Size process attributes");
            attributes=Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes,1,0,ref size),"Initialize process attributes"); attributesInitialized=true;
            handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
            for (int i=0;i<3;i++) Marshal.WriteIntPtr(handleList,i*IntPtr.Size,standard[i]);
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Whitelist standard handles");
            string application=Resolve(executable);
            var command=new StringBuilder(Quote(application));
            foreach (var argument in arguments) command.Append(' ').Append(Quote(argument));
            if (command.Length>=32767) throw new ArgumentException("Native command line exceeds the Windows limit.");
            var startup=new StartupInfoEx(); startup.info.cb=Marshal.SizeOf(typeof(StartupInfoEx));
            startup.info.flags=0x00000100; startup.info.input=standard[0]; startup.info.output=standard[1]; startup.info.error=standard[2]; startup.attributes=attributes;
            // Inherit this owner's exact environment; the private Job handle is not inherited.
            Check(CreateProcessW(application,command,IntPtr.Zero,IntPtr.Zero,true,0x00080004,IntPtr.Zero,directory,ref startup,out process),"Create suspended native process");
            Check(AssignProcessToJobObject(job,process.process),"Assign native process to private Job"); assigned=true;
            if (WaitForSingleObject(parent,0)!=258) throw new InvalidOperationException("The owner parent stopped before process startup.");
            if (ResumeThread(process.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(),"Resume owned process");
            uint wait=WaitForMultipleObjects(2,new IntPtr[] {process.process,parent},false,0xffffffff);
            if (wait==0) {
                uint code; Check(GetExitCodeProcess(process.process,out code),"Read native exit status"); exit=unchecked((int)code);
            } else if (wait==1) exit=130;
            else throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait for native process or owner loss");
        } catch (Exception error) { primary=error; }
        finally {
            try {
                if (assigned) StopAndWait(job);
                else if (process.process!=IntPtr.Zero) {
                    Check(TerminateProcess(process.process,130),"Terminate unstarted owned process");
                    if (WaitForSingleObject(process.process,10000)!=0) throw new TimeoutException("Unstarted process cleanup did not finish.");
                }
            } catch (Exception error) { cleanup=error; }
            // Job close is a last safety net if cleanup failed; its HANDLE never leaves this owner.
            if (job!=IntPtr.Zero) CloseHandle(job);
            if (process.thread!=IntPtr.Zero) CloseHandle(process.thread);
            if (process.process!=IntPtr.Zero) CloseHandle(process.process);
            if (parent!=IntPtr.Zero) CloseHandle(parent);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            for (int i=0;i<marked;i++) SetHandleInformation(standard[i],1,originalFlags[i]&1);
        }
        if (primary!=null) Console.Error.WriteLine("PerfChecker native process failed: "+primary.Message);
        if (cleanup!=null) Console.Error.WriteLine("PerfChecker native process cleanup failed: "+cleanup.Message);
        return primary!=null || cleanup!=null ? 1 : exit;
    }
}
'@
    $arguments = [string[]]@(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))))
    $exitCode = [PerfCheckerOwnedProcess]::Run($Executable, $arguments, $WorkingDirectory, $ParentPid)
    exit $exitCode
} catch {
    [Console]::Error.WriteLine('PerfChecker Windows process owner failed: ' + $_.Exception.Message)
    exit 1
}
