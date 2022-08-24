use anyhow::Result;
use async_trait::async_trait;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct Tokens {
    pub text: String,
    pub tokens: Option<Vec<String>>,
    pub logprobs: Option<Vec<Option<f32>>>,
}

#[derive(Debug)]
pub struct Generation {
    pub provider: String,
    pub model: String,
    pub completions: Vec<Tokens>,
    pub prompt: Tokens,
}

#[async_trait]
pub trait LLM {
    fn id(&self) -> String;
    fn name(&self) -> String;

    fn initialize(&mut self) -> Result<()>;

    async fn generate(
        &self,
        prompt: String,
        max_tokens: Option<i32>,
        temperature: f32,
        n: usize,
        stop: Option<Vec<String>>,
    ) -> Result<Generation>;
}
