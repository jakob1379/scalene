cmake_minimum_required(VERSION 3.26...4.4)
project(${SKBUILD_PROJECT_NAME} LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Release wheels set ARCHFLAGS="-arch x86_64 -arch arm64" (universal2); the
# arm64e slice rides along, as build-and-upload.yml checks for it.
if(APPLE AND "arm64" IN_LIST CMAKE_OSX_ARCHITECTURES
   AND NOT "arm64e" IN_LIST CMAKE_OSX_ARCHITECTURES)
  list(APPEND CMAKE_OSX_ARCHITECTURES arm64e)
endif()

find_package(Python REQUIRED COMPONENTS Interpreter Development.Module)

# Windows' shared pyconfig.h doesn't define Py_GIL_DISABLED for free-threaded builds.
if(WIN32 AND Python_SOABI MATCHES "^cp[0-9]+t-")
  add_compile_definitions(Py_GIL_DISABLED=1)
endif()

include(FetchContent)
FetchContent_Declare(heap_layers
  URL https://github.com/emeryberger/Heap-Layers/archive/9400e88e81cca2ef390f7a0c39d22180397a66e9.tar.gz
  URL_HASH SHA256=1ae5c485f34c62e2ffd3c4bfb40f9d8c5674d54c8837927fc825a64756ec9d8b)
FetchContent_Declare(printf
  URL https://github.com/mpaland/printf/archive/d3b984684bb8a8bdc48cc7a1abecb93ce59bbe3e.tar.gz
  URL_HASH SHA256=4b5a9be01deea0af6452844d9d6ec5d60509f33ed8a73e1a9fba54155137043f)
FetchContent_MakeAvailable(heap_layers printf)

# libscalene calls the C library's printf/vsnprintf; keep printf.h from renaming them.
file(READ "${printf_SOURCE_DIR}/printf.h" printf_h)
if(NOT printf_h MATCHES "//#define printf printf_")
  string(REPLACE "#define printf printf_" "//#define printf printf_" printf_h "${printf_h}")
  string(REPLACE "#define vsnprintf vsnprintf_" "//#define vsnprintf vsnprintf_" printf_h "${printf_h}")
  file(WRITE "${printf_SOURCE_DIR}/printf.h" "${printf_h}")
endif()
set_source_files_properties("${printf_SOURCE_DIR}/printf.c" PROPERTIES LANGUAGE CXX)

# Python extension modules

python_add_library(get_line_atomic MODULE WITH_SOABI src/source/get_line_atomic.cpp)
target_include_directories(get_line_atomic PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR} ${heap_layers_SOURCE_DIR} ${heap_layers_SOURCE_DIR}/utility)

python_add_library(pywhere MODULE WITH_SOABI
  src/source/pywhere.cpp src/source/traceconfig.cpp)
target_include_directories(pywhere PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/src/include)

# Native stack unwinder: static libunwind on Linux, libSystem's <unwind.h> on
# macOS, a stub on Windows.
python_add_library(_scalene_unwind MODULE WITH_SOABI src/source/native_unwind.cpp)
target_include_directories(_scalene_unwind PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  include(ExternalProject)
  set(libunwind_prefix "${CMAKE_CURRENT_BINARY_DIR}/libunwind")
  set(libunwind_libs "${libunwind_prefix}/lib/libunwind.a")
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64)$")
    set(libunwind_arch x86_64)
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
    set(libunwind_arch aarch64)
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^arm")
    set(libunwind_arch arm)
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^ppc64")
    set(libunwind_arch ppc64)
  endif()
  if(libunwind_arch)
    list(PREPEND libunwind_libs "${libunwind_prefix}/lib/libunwind-${libunwind_arch}.a")
  endif()
  ExternalProject_Add(libunwind
    URL https://github.com/libunwind/libunwind/releases/download/v1.8.1/libunwind-1.8.1.tar.gz
    URL_HASH SHA256=ddf0e32dd5fafe5283198d37e4bf9decf7ba1770b6e7e006c33e6df79e6a6157
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    INSTALL_DIR "${libunwind_prefix}"
    CONFIGURE_COMMAND <SOURCE_DIR>/configure
      --prefix=<INSTALL_DIR> --libdir=<INSTALL_DIR>/lib
      --enable-static --disable-shared --disable-tests
      --disable-documentation --disable-coredump
      --disable-ptrace --disable-setjmp
      --disable-minidebuginfo --disable-zlibdebuginfo
      "CC=${CMAKE_C_COMPILER}" "CFLAGS=-fPIC -O2"
    BUILD_COMMAND make -j
    INSTALL_COMMAND make install
    BUILD_BYPRODUCTS ${libunwind_libs})
  add_dependencies(_scalene_unwind libunwind)
  target_include_directories(_scalene_unwind PRIVATE "${libunwind_prefix}/include")
  target_link_libraries(_scalene_unwind PRIVATE ${libunwind_libs} dl)
endif()

install(TARGETS get_line_atomic pywhere _scalene_unwind DESTINATION scalene)

# libscalene: the allocator shim preloaded into profiled processes

if(WIN32)
  FetchContent_Declare(detours
    URL https://github.com/microsoft/Detours/archive/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7.tar.gz
    URL_HASH SHA256=38d435d2750b4e3af57f56c77af52bc058123c5e7dd734945b7680ec52e5c91c)
  FetchContent_MakeAvailable(detours)

  set(detours_sources
    ${detours_SOURCE_DIR}/src/detours.cpp
    ${detours_SOURCE_DIR}/src/modules.cpp
    ${detours_SOURCE_DIR}/src/disasm.cpp
    ${detours_SOURCE_DIR}/src/image.cpp
    ${detours_SOURCE_DIR}/src/creatwth.cpp)
  # The target's, not the host's: x64 Python on an ARM64 machine builds x64.
  if(CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "ARM64")
    list(APPEND detours_sources ${detours_SOURCE_DIR}/src/disolarm64.cpp)
  elseif(CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "x64")
    list(APPEND detours_sources ${detours_SOURCE_DIR}/src/disolx64.cpp)
  elseif(CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "X86")
    list(APPEND detours_sources ${detours_SOURCE_DIR}/src/disolx86.cpp)
  endif()

  add_library(scalene SHARED
    src/source/libscalene_windows.cpp ${printf_SOURCE_DIR}/printf.c ${detours_sources})
  target_include_directories(scalene PRIVATE
    src src/include
    ${heap_layers_SOURCE_DIR} ${heap_layers_SOURCE_DIR}/wrappers ${heap_layers_SOURCE_DIR}/utility
    ${printf_SOURCE_DIR} ${detours_SOURCE_DIR}/src)
  target_compile_definitions(scalene PRIVATE
    WIN32_LEAN_AND_MEAN _REENTRANT=1 NDEBUG HL_USE_XXREALLOC=1
    SCALENE_LIBSCALENE_BUILD=1 _CRT_SECURE_NO_WARNINGS=1)
  target_compile_options(scalene PRIVATE /W3 /O2 /EHsc)
  target_link_libraries(scalene PRIVATE kernel32 user32 psapi Python::Module)
  set_target_properties(scalene PROPERTIES CXX_STANDARD 20 OUTPUT_NAME libscalene)
else()
  if(APPLE)
    set(wrapper macwrapper.cpp)
  else()
    set(wrapper gnuwrapper.cpp)
  endif()
  add_library(scalene SHARED
    src/source/libscalene.cpp
    ${heap_layers_SOURCE_DIR}/wrappers/${wrapper}
    ${printf_SOURCE_DIR}/printf.c)
  target_include_directories(scalene PRIVATE
    src src/include
    ${heap_layers_SOURCE_DIR} ${heap_layers_SOURCE_DIR}/wrappers ${heap_layers_SOURCE_DIR}/utility
    ${printf_SOURCE_DIR} ${Python_INCLUDE_DIRS})
  target_compile_definitions(scalene PRIVATE _REENTRANT=1 HL_USE_XXREALLOC=1)
  target_compile_options(scalene PRIVATE
    -Wall -pipe -fno-builtin-malloc -fvisibility=hidden)
  target_link_libraries(scalene PRIVATE ${CMAKE_DL_LIBS} pthread)
  if(APPLE)
    target_compile_options(scalene PRIVATE
      -flto -ftls-model=initial-exec -ftemplate-depth=1024)
    target_link_options(scalene PRIVATE -flto)
    set_target_properties(scalene PROPERTIES
      MACHO_COMPATIBILITY_VERSION 1 MACHO_CURRENT_VERSION 1)
  else()
    target_include_directories(scalene PRIVATE /usr/include/nptl)
    target_compile_options(scalene PRIVATE -Wno-unused-result)
  endif()
endif()

install(FILES $<TARGET_FILE:scalene> DESTINATION scalene)
