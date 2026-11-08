cmake_minimum_required(VERSION 3.22)
project(pocketllm)

# llama.cpp 源码由 tools/fetch-llamacpp.sh 拉取到本目录下的 llama.cpp/
if (NOT EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/CMakeLists.txt)
    message(FATAL_ERROR "llama.cpp 未找到：请先在 PC 上运行 tools/fetch-llamacpp.sh（或手动 git clone llama.cpp 到 app/src/main/cpp/llama.cpp）")
endif()

set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
add_subdirectory(llama.cpp)

add_library(pocketllm SHARED llama-jni.cpp)
target_link_libraries(pocketllm PRIVATE llama log)
