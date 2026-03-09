#!/usr/bin/env python3
import pexpect
import sys
import os
import time

os.chdir('/home/runner/workspace')

print("Starting EAS build automation...")
print("=" * 60)

child = pexpect.spawn(
    './node_modules/.bin/eas build --profile development --platform android --no-wait',
    timeout=300,
    encoding='utf-8',
    echo=False
)
child.logfile = sys.stdout

patterns = [
    'Would you like to automatically create',   # 0
    'Generate a new Android Keystore',           # 1
    'Generate new Android Keystore',             # 2
    'Do you want to set up a new keystore',      # 3
    'Which build credentials sources',           # 4
    r'https://expo\.dev/accounts/',              # 5
    r'https://expo\.dev/builds/',                # 6
    'Error:',                                    # 7
    pexpect.EOF,                                 # 8
    pexpect.TIMEOUT,                             # 9
]

build_url = None
error_detected = False

while True:
    try:
        idx = child.expect(patterns, timeout=120)
        
        if idx == 0:  # project creation
            print("\n[AUTO] Answering: y (create project)")
            child.sendline('y')
            
        elif idx in [1, 2, 3]:  # keystore generation
            print("\n[AUTO] Answering: y (generate keystore)")
            child.sendline('y')
            
        elif idx == 4:  # which build credentials
            print("\n[AUTO] Pressing Enter (default: Expo server)")
            child.sendline('')
            
        elif idx in [5, 6]:  # build URL
            line = child.after
            print(f"\n[BUILD URL FOUND]: {line}")
            build_url = line
            
        elif idx == 7:  # error
            print("\n[ERROR DETECTED]")
            error_detected = True
            
        elif idx == 8:  # EOF
            print("\n[PROCESS FINISHED]")
            break
            
        elif idx == 9:  # timeout
            print("\n[TIMEOUT after 120s - process still running?]")
            break
            
    except Exception as e:
        print(f"\nException: {e}")
        break

child.close()
print("\n" + "=" * 60)
print(f"Exit code: {child.exitstatus}")
if build_url:
    print(f"Build URL: {build_url}")
if error_detected:
    print("ERROR: Build failed")
    sys.exit(1)
